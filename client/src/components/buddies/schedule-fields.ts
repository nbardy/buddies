import type { Schedule } from '@unleashd/buddies-core';
import type { BuddyMutationInput } from '@unleashd/shared';

export type ScheduleFields = Omit<BuddyMutationInput<'schedule.update'>, 'key'>;

// Omitting taskId when replacing a schedule detached it from its Task.
// Guard: client schedule edit over owner HTTP (buddies-v2.test.ts).
export const scheduleFieldsOf = (schedule: Schedule): ScheduleFields => ({
  taskId: schedule.taskId,
  name: schedule.name,
  cron: schedule.cron,
  timezone: schedule.timezone,
  prompt: schedule.prompt,
  enabled: schedule.enabled,
});
