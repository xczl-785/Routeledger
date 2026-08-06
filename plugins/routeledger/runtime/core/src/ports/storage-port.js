const SNAPSHOT_HEAD_REVISION = Symbol("routeledger.snapshotHeadRevision");
export const attachProjectAggregateHeadRevision = (snapshot, headRevision) => {
    Object.defineProperty(snapshot, SNAPSHOT_HEAD_REVISION, {
        value: headRevision,
        enumerable: true,
        writable: true,
        configurable: true
    });
    return snapshot;
};
export const getProjectAggregateHeadRevision = (snapshot) => snapshot[SNAPSHOT_HEAD_REVISION];
