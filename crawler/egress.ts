export interface EgressProfile {
  ip?: string;
  org?: string;
}

export type EgressKind = 'home' | 'residential_isp' | 'datacenter' | 'unknown';

const DATACENTER_ORG_RE =
  /oracle|amazon|aws|google|gcp|microsoft|azure|ovh|hetzner|digitalocean|linode|akamai|vultr|contabo|leaseweb|choopa|cloudflare|cloud|hosting|host|datacenter|data center|colo|colocation|server|vps/i;

const RESIDENTIAL_ORG_RE =
  /korea telecom|kt|sk broadband|sk telecom|lg u\+|lg유플러스|lgu\+|uplus|dacom|comcast|xfinity|verizon|at&t|charter|spectrum|cox|frontier|centurylink|lumen|t-mobile|tmobile|telefonica|vodafone|orange|deutsche telekom|bt|virgin media|docomo|softbank|kddi|telstra|singtel|telecom|broadband|cable|fiber|fibre|isp|internet service/i;

export function configuredHomeIps(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export function classifyEgress(profile: EgressProfile, homeIps = configuredHomeIps(process.env.CRAWL_HOME_IPS)): EgressKind {
  const ip = profile.ip?.trim();
  const org = profile.org ?? '';
  if (DATACENTER_ORG_RE.test(org)) return 'datacenter';
  if (RESIDENTIAL_ORG_RE.test(org)) return ip && homeIps.has(ip) ? 'home' : 'residential_isp';
  return 'unknown';
}
