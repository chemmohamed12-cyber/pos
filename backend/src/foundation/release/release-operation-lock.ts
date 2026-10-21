/**
 * In-process mutual exclusion between a deploy and a Company catch-up (1.1.13). Both change Company databases; the database-level guard (a newer release row in
 * `deploying` / `migrating` / `health_checking`) cannot see a deploy that has not yet written its row, nor a catch-up that is running. The Release Center runs in ONE
 * application process, so a process-wide flag closes that window: a deploy refuses while a catch-up runs and a catch-up refuses while a deploy runs.
 */
export class ReleaseOperationLock {
  private deploys = 0;
  private catchUp = false;

  get deployInProgress(): boolean {
    return this.deploys > 0;
  }
  get catchUpRunning(): boolean {
    return this.catchUp;
  }
  beginDeploy(): void {
    this.deploys += 1;
  }
  endDeploy(): void {
    this.deploys = Math.max(0, this.deploys - 1);
  }
  beginCatchUp(): void {
    this.catchUp = true;
  }
  endCatchUp(): void {
    this.catchUp = false;
  }
}

export const releaseOperationLock = new ReleaseOperationLock();
