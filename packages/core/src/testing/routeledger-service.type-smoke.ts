import type {
  VersionCloseoutPlan,
  VersionCloseoutSummary
} from "../application/routeledger-service.js";

type Assert<T extends true> = T;
type IsObjectLike<T> = T extends object ? true : false;

export type RouteLedgerServiceTypeSmoke = [
  Assert<IsObjectLike<VersionCloseoutPlan>>,
  Assert<IsObjectLike<VersionCloseoutSummary>>
];
