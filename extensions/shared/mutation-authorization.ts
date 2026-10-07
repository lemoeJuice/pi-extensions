/**
 * One-shot authorization attached to a single tool argument object and bound to the reviewed
 * cwd/patch. Weak identity keeps it out of serialized/model-visible arguments and lets unused
 * grants be collected naturally.
 */
const outsideWorkingDirectoryGrants = new WeakMap<object, { cwd: string; patch: string }>();

export function grantOutsideWorkingDirectory(invocation: object, cwd: string, patch: string): void {
  outsideWorkingDirectoryGrants.set(invocation, { cwd, patch });
}

export function consumeOutsideWorkingDirectoryGrant(invocation: object, cwd: string, patch: string): boolean {
  const grant = outsideWorkingDirectoryGrants.get(invocation);
  outsideWorkingDirectoryGrants.delete(invocation);
  return grant?.cwd === cwd && grant.patch === patch;
}
