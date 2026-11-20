import { randomUUID } from "node:crypto";
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { applyChannelEdits, initialLaunch, launchTargets, type LaunchJob } from "./launch-model";
import { getLaunch, launchContext, launchView, putLaunch } from "./launch-storage";
import { env } from "./runtime";
import { HttpError, keyPattern, scheduleTime } from "./model";

const scheduler = new SchedulerClient({});
const sqs = new SQSClient({});

async function removeSchedule(id: string) {
  try {
    await scheduler.send(new DeleteScheduleCommand({ GroupName: env.SCHEDULE_GROUP, Name: id }));
  } catch (error) {
    if ((error as Error).name !== "ResourceNotFoundException") console.warn("Launch schedule cleanup deferred", (error as Error).name);
  }
}

export async function handleLaunch({ email, host, sourceHost, did, handle, rkey, method, body }: {
  email: string; host: string; sourceHost: string; did: string; handle: string; rkey: string; method: string; body?: unknown;
}) {
  if (!keyPattern.test(rkey)) throw new HttpError(404, "This article is unavailable.");
  const [context, existing] = await Promise.all([launchContext(did, rkey, sourceHost, handle), getLaunch(did, rkey)]);
  if (method === "GET") return launchView(context, existing);
  if (method !== "POST") throw new HttpError(405, "Choose a launch action.");
  if (!context.item.managedLaunch) throw new HttpError(409, "This article uses automatic syndication.");
  let row = existing ?? initialLaunch(did, context.item, context.activityPubUrl);
  const data = body as { action?: unknown; version?: unknown; channels?: unknown; at?: unknown } | null | undefined;
  if (data?.version !== row.version) throw new HttpError(409, "The launch changed. Refresh to see the current status.");
  const action = data.action;
  if (action === "cancel") {
    if (!row.job?.at || row.job.leaseUntil || Date.parse(row.job.at) <= Date.now()) {
      throw new HttpError(409, "This launch has started or is no longer scheduled.");
    }
    const id = row.job.id;
    row = await putLaunch({ ...row, job: undefined });
    await removeSchedule(id);
    return launchView(context, row);
  }
  if (row.job) throw new HttpError(409, "This launch is already scheduled or running.");
  if (action === "save" || action === "launch") row = applyChannelEdits(row, data.channels);
  if (action === "save") return launchView(context, await putLaunch(row));
  if (action !== "launch" && action !== "retry") throw new HttpError(400, "Choose a launch action.");
  const platforms = launchTargets(row, action, context.article.url);
  const at = data.at === undefined || action === "retry" ? undefined : scheduleTime(data.at);
  const job: LaunchJob = { did, launchRkey: rkey, jobId: randomUUID() };
  const date = at ?? new Date(Date.now() + 120_000).toISOString();
  // The schedule exists before the conditional commit. Stale deliveries never
  // run, and a lost write response does not remove a possibly committed job.
  await scheduler.send(new CreateScheduleCommand({
    Name: job.jobId, GroupName: env.SCHEDULE_GROUP, ScheduleExpression: `at(${date.slice(0, 19)})`,
    ScheduleExpressionTimezone: "UTC", FlexibleTimeWindow: { Mode: "OFF" }, ActionAfterCompletion: "DELETE",
    Target: {
      Arn: env.QUEUE_ARN!, RoleArn: env.SCHEDULE_ROLE!, Input: JSON.stringify(job),
      DeadLetterConfig: { Arn: env.DEAD_LETTER_ARN },
      RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 10 },
    },
  }));
  row = await putLaunch({ ...row, job: { id: job.jobId, email, host, platforms, at } }).catch(async error => {
    if ((error as Error).name === "ConditionalCheckFailedException") await removeSchedule(job.jobId);
    throw error;
  });
  if (!at) {
    try {
      await sqs.send(new SendMessageCommand({ QueueUrl: env.QUEUE_URL, MessageBody: JSON.stringify(job) }));
    } catch (error) {
      console.warn("Immediate launch deferred to Scheduler", (error as Error).name);
    }
  }
  return launchView(context, row);
}
