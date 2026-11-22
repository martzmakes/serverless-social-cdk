// CloudFront edge location → approximate viewer region.
//
// Every standard-log row carries `x-edge-location` (for example `IAD89-P1`),
// whose first three letters are the metro's airport code. CloudFront routes a
// viewer to a nearby edge, so the edge's country is a free, IP-free estimate of
// the reader's country. It is approximate: a reader can be served from a
// neighbouring country's edge, and a whole region can share one metro.

/** Metro code → [city, ISO 3166-1 alpha-2 country]. */
const EDGES: Record<string, readonly [string, string]> = {
  // North America
  ATL: ["Atlanta", "US"], AUS: ["Austin", "US"], BNA: ["Nashville", "US"], BOS: ["Boston", "US"],
  CLT: ["Charlotte", "US"], CMH: ["Columbus", "US"], DEN: ["Denver", "US"], DFW: ["Dallas", "US"],
  DTW: ["Detroit", "US"], EWR: ["Newark", "US"], HIO: ["Hillsboro", "US"], HNL: ["Honolulu", "US"],
  IAD: ["Ashburn", "US"], IAH: ["Houston", "US"], IND: ["Indianapolis", "US"], JAX: ["Jacksonville", "US"],
  JFK: ["New York", "US"], LAS: ["Las Vegas", "US"], LAX: ["Los Angeles", "US"], MCI: ["Kansas City", "US"],
  MIA: ["Miami", "US"], MSP: ["Minneapolis", "US"], ORD: ["Chicago", "US"], PDX: ["Portland", "US"],
  PHL: ["Philadelphia", "US"], PHX: ["Phoenix", "US"], PIT: ["Pittsburgh", "US"], SAN: ["San Diego", "US"],
  SEA: ["Seattle", "US"], SFO: ["San Francisco", "US"], SJC: ["San Jose", "US"], SLC: ["Salt Lake City", "US"],
  STL: ["St. Louis", "US"], TPA: ["Tampa", "US"], ANC: ["Anchorage", "US"], OMA: ["Omaha", "US"],
  YTO: ["Toronto", "CA"], YYZ: ["Toronto", "CA"], YUL: ["Montréal", "CA"], YVR: ["Vancouver", "CA"],
  YYC: ["Calgary", "CA"], QRO: ["Querétaro", "MX"], MEX: ["Mexico City", "MX"], GDL: ["Guadalajara", "MX"],
  // South America
  BOG: ["Bogotá", "CO"], EZE: ["Buenos Aires", "AR"], FOR: ["Fortaleza", "BR"], GIG: ["Rio de Janeiro", "BR"],
  GRU: ["São Paulo", "BR"], LIM: ["Lima", "PE"], SCL: ["Santiago", "CL"], UIO: ["Quito", "EC"],
  // Europe
  AMS: ["Amsterdam", "NL"], ARN: ["Stockholm", "SE"], ATH: ["Athens", "GR"], BCN: ["Barcelona", "ES"],
  BER: ["Berlin", "DE"], BRU: ["Brussels", "BE"], BUD: ["Budapest", "HU"], CDG: ["Paris", "FR"],
  CPH: ["Copenhagen", "DK"], DUB: ["Dublin", "IE"], DUS: ["Düsseldorf", "DE"], FCO: ["Rome", "IT"],
  FRA: ["Frankfurt", "DE"], HAM: ["Hamburg", "DE"], HEL: ["Helsinki", "FI"], IST: ["Istanbul", "TR"],
  LHR: ["London", "GB"], LIS: ["Lisbon", "PT"], MAD: ["Madrid", "ES"], MAN: ["Manchester", "GB"],
  MRS: ["Marseille", "FR"], MUC: ["Munich", "DE"], MXP: ["Milan", "IT"], OSL: ["Oslo", "NO"],
  OTP: ["Bucharest", "RO"], PMO: ["Palermo", "IT"], PRG: ["Prague", "CZ"], SOF: ["Sofia", "BG"],
  TXL: ["Berlin", "DE"], VIE: ["Vienna", "AT"], WAW: ["Warsaw", "PL"], ZAG: ["Zagreb", "HR"],
  ZRH: ["Zurich", "CH"], EDI: ["Edinburgh", "GB"], KBP: ["Kyiv", "UA"], BEG: ["Belgrade", "RS"],
  // Middle East and Africa
  BAH: ["Manama", "BH"], CAI: ["Cairo", "EG"], CPT: ["Cape Town", "ZA"], DOH: ["Doha", "QA"],
  DXB: ["Dubai", "AE"], FJR: ["Fujairah", "AE"], JED: ["Jeddah", "SA"], JNB: ["Johannesburg", "ZA"],
  LOS: ["Lagos", "NG"], MCT: ["Muscat", "OM"], NBO: ["Nairobi", "KE"], RUH: ["Riyadh", "SA"],
  TLV: ["Tel Aviv", "IL"], DMM: ["Dammam", "SA"], KWI: ["Kuwait City", "KW"],
  // Asia Pacific
  AKL: ["Auckland", "NZ"], BKK: ["Bangkok", "TH"], BLR: ["Bengaluru", "IN"], BNE: ["Brisbane", "AU"],
  BOM: ["Mumbai", "IN"], CCU: ["Kolkata", "IN"], CGK: ["Jakarta", "ID"], CMB: ["Colombo", "LK"],
  DEL: ["New Delhi", "IN"], HAN: ["Hanoi", "VN"], HKG: ["Hong Kong", "HK"], HYD: ["Hyderabad", "IN"],
  ICN: ["Seoul", "KR"], KIX: ["Osaka", "JP"], KUL: ["Kuala Lumpur", "MY"], MAA: ["Chennai", "IN"],
  MEL: ["Melbourne", "AU"], MNL: ["Manila", "PH"], NRT: ["Tokyo", "JP"], HND: ["Tokyo", "JP"],
  PER: ["Perth", "AU"], PNQ: ["Pune", "IN"], SGN: ["Ho Chi Minh City", "VN"], SIN: ["Singapore", "SG"],
  SYD: ["Sydney", "AU"], TPE: ["Taipei", "TW"], DAC: ["Dhaka", "BD"], KHI: ["Karachi", "PK"],
  CHC: ["Christchurch", "NZ"], CEB: ["Cebu", "PH"],
};

export type EdgeLocation = { edge: string; country: string };

/** Unknown or malformed edges keep their code but report country `ZZ`. */
export function edgeLocation(raw: string | undefined): EdgeLocation | undefined {
  const code = /^([A-Z]{3})\d/.exec(raw ?? "")?.[1];
  if (!code) return undefined;
  return { edge: code, country: EDGES[code]?.[1] ?? "ZZ" };
}

/** City label for a metro code, when known. */
export function edgeCity(code: string): string | undefined {
  return EDGES[code]?.[0];
}

/** Country for a metro code; `ZZ` when unknown. */
export function edgeCountry(code: string): string {
  return EDGES[code]?.[1] ?? "ZZ";
}
