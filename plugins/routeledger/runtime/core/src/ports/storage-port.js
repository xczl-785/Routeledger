/** @deprecated Read the public `snapshot.headRevision` field directly. */
export const attachProjectAggregateHeadRevision = (snapshot, headRevision) => {
    snapshot.headRevision = headRevision;
    return snapshot;
};
/** @deprecated Read the public `snapshot.headRevision` field directly. */
export const getProjectAggregateHeadRevision = (snapshot) => snapshot.headRevision;
