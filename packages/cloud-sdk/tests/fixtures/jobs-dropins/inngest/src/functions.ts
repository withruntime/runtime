// Inngest's own examples, with `inngest` changed to `withruntime/inngest`:
// the client and event function from inngest/inngest-js's README
// (packages/inngest/README.md), and the scheduled function from Inngest's
// docs (guides/scheduled-functions), 26 October 2026.
import { Inngest } from "withruntime/inngest";

export const inngest = new Inngest({ id: "my-app" });

const sendEmail = async (message: { email: string; template: string }) =>
  console.log(`email ${message.template} to ${message.email}`);

export const onboarding = inngest.createFunction(
  {
    id: "user-onboarding-communication",
    triggers: [{ event: "app/user.signup" }],
  },
  async ({ event, step }) => {
    await step.run("Send welcome email", async () => {
      await sendEmail({
        email: (event.data as { email: string }).email,
        template: "welcome",
      });
    });
  },
);

export const prepareWeeklyDigest = inngest.createFunction(
  { id: "prepare-weekly-digest" },
  { cron: "TZ=Europe/Paris 0 12 * * 5" },
  async ({ step }) => {
    const users = await step.run("load-users", async () => [{ id: 1, email: "a@example.com" }]);
    await step.sleep("pause", "1s");
    console.log(`digest for ${users.length} users`);
    return { sent: users.length };
  },
);
