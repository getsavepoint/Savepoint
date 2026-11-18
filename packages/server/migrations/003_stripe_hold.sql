-- Phase 2C: non-custodial Stripe auth-hold (capture_method: manual).

ALTER TABLE savepoint_snapshots DROP CONSTRAINT IF EXISTS savepoint_snapshots_action_type_check;
ALTER TABLE savepoint_snapshots ADD CONSTRAINT savepoint_snapshots_action_type_check CHECK (action_type IN (
  'pg.update', 'pg.delete', 'stripe.refund', 'stripe.authorize_hold',
  's3.put', 's3.delete', 's3.acl',
  'github.issue_update', 'github.pr_update', 'github.branch_delete',
  'slack.post', 'slack.archive'));
