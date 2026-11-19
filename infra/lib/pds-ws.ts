import { Construct } from 'constructs'
import {
  WebSocketApi,
  WebSocketStage,
} from 'aws-cdk-lib/aws-apigatewayv2'
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import type { IFunction } from 'aws-cdk-lib/aws-lambda'
import type { IGrantable } from 'aws-cdk-lib/aws-iam'
import type { Grant } from 'aws-cdk-lib/aws-iam'

export interface FirehoseWsProps {
  /** Lambda handling $connect route */
  readonly connectFn: IFunction
  /** Lambda handling $disconnect route */
  readonly disconnectFn: IFunction
  /** Lambda handling $default route */
  readonly defaultFn: IFunction
}

/**
 * FirehoseWs — WebSocket API for the AT Protocol subscribeRepos firehose.
 *
 * Stage name is `$default` with autoDeploy so there is no separate
 * manual deployment step. Connections are stored in RepoTable as
 * `CONN#<connectionId>/CONN` items (Task 3 implements the handler bodies).
 *
 * Tasks 3/4 replace the Lambda entry implementations; this construct's
 * API (props, `.api`, `.stage`) is the stable interface they depend on.
 */
export class FirehoseWs extends Construct {
  readonly api: WebSocketApi
  readonly stage: WebSocketStage

  constructor(scope: Construct, id: string, props: FirehoseWsProps) {
    super(scope, id)

    this.api = new WebSocketApi(this, 'FirehoseWsApi', {
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration('ConnIntegration', props.connectFn),
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration('DisconnIntegration', props.disconnectFn),
      },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration('DefaultIntegration', props.defaultFn),
      },
    })

    this.stage = new WebSocketStage(this, 'FirehoseWsStage', {
      webSocketApi: this.api,
      stageName: '$default',
      autoDeploy: true,
    })
  }

  /**
   * Grant `execute-api:ManageConnections` on this WebSocket API to the given
   * grantable (Lambda execution role). Required for posting back to clients.
   */
  grantManageConnections(grantable: IGrantable): Grant {
    return this.api.grantManageConnections(grantable)
  }
}
