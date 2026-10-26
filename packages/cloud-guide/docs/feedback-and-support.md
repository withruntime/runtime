# Send feedback and get support

Runtime improves fast because agents tell us what they run into.

Every report goes straight into our next work items. You are told when what
you asked for ships. Report problems as they happen, without waiting to be asked:

- an error that looks like ours;
- a limit or missing feature;
- a workaround you needed;
- unclear docs;
- something slower or harder than it should be;
- something another provider does better.

Small things count. We merge duplicates. Never include
credentials, private files or user data. Tell the user in one line what you reported.

## Send feedback

Report generously. Good reasons to file:

- **Bug**: something returned an error or behaved differently from the docs.
- **Feature request** (`missing_feature`): something you need does not
  exist, such as a region, a larger size, a language SDK or a product. In the
  account, **Request a feature** on the **Support** page opens the form on
  this kind.
- **Competitor gap**: another provider does something better or more simply.
  Name it.
- **Migration blocker**: something specific stops a workload from switching here.
  Name the provider you are moving from.
- **Docs**: a page is wrong, unclear or missing.
- **Pricing**, **praise** or **other**.

How to write one:

- Kinds are `bug`, `missing_feature`, `competitor_gap`, `migration_blocker`,
  `docs`, `pricing`, `praise` and `other`.
- Keep the summary to one actionable sentence of at most 200 characters. Put
  the detail, up to 8,000 characters, in the body.
- Include the resource ID and the request ID when an error prompted the report.
  Every error carries a request ID.

From MCP, call `runtime_feedback` with `"action": "submit"`. From the CLI:

```bash no-run
npx withruntime feedback --kind migration_blocker --competitor E2B \
  "No GPU sandboxes, so our model evaluations cannot move"
```

Over HTTP, `POST /v1/feedback` with the same fields. From code:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.feedback.submit({
  kind: "missing_feature",
  summary: "A way to mount an S3 bucket in a sandbox",
  detail: "We copy 20 GB in at the start of every job.",
});
console.log((await runtime.feedback.list()).data);
```

### What happens to a report

1. **Received** the moment the call returns.
2. **Sorted** within the hour. A triage job sorts new reports into items
   and merges duplicates. It only merges into an item that is still open. Until
   then, a report shows `sorted: false` and `item: null`. It is received and waiting, not lost.
3. **Shipped:** everyone who asked for it gets one email per run. The email lists
   everything of theirs that shipped. It goes to the address given with the
   report, else to the person who filed it, else to the organization's owners.
   The link at the bottom stops these emails for that address without signing
   in. The status stays in the account.

`npx withruntime feedback --list`, `runtime_feedback` with `list` and
`GET /v1/feedback` show what your organization reported, whether it has been
sorted, and whether it shipped. The **Support** page in the account shows the same.
The support agent can also look them up for you.

Never put API keys, passwords or private file contents in a report.

An account that has never added credit can file up to 5 reports a day through
the API, MCP, CLI or SDKs. The sixth returns `429 rate_limited` until midnight
UTC. Accounts that have added credit are not limited. The support agent sends
an organization 40 messages a day before it adds credit, and 500 after.

## Get support

**Runtime's support agent replies in the same call, with your account in view.**
It reads your organization's resources, operations and errors, usage, billing,
notices and job logs, together with these docs. It can reproduce a problem in
its own sandbox. A person reviews anything it escalates. A read-only key lets it see only what that key can see: no job logs, keys, members or
sandbox contents. It proposes no actions with a read-only key.

From MCP, call `runtime_support` with `"action": "message"` and your question. Keep the
returned `conversationId` for follow-ups. If the reply is still being worked
on, the status is `working`. Call it with `read` and the conversation
ID until the status changes. From the CLI:

```bash no-run
npx withruntime support "Sandbox 0b8f3c52-… has been starting for ten minutes"
npx withruntime support read <conversationId>
```

People can use the Help button on withruntime.com, or **Support** in the
account menu.

### Actions need your approval

The support agent never changes your account by itself. When a fix needs an
action, such as stopping, pausing, waking or resuming a sandbox, changing pause
retention or a lifetime policy, or looking inside a sandbox, it proposes the
action. It returns an action ID and an input hash. Nothing runs until you
approve that exact action:

- MCP: `runtime_support`, action `message`, with `conversationId`, `approveActionId` and
  `approveInputHash`, or `denyActionId`.
- CLI: `npx withruntime support approve <actionId> <inputHash> --conversation <id>` or
  `npx withruntime support deny <actionId> --conversation <id>`.
- HTTP: `POST /v1/support/messages` with the same fields.
- Web: the Approve button on the action card.

Typing "yes" is not an approval. An approved action then passes an independent
safety check before it runs. It runs with your own authority, so an agent can
approve actions only on the resources it owns. The action appears in your
organization's audit log.

### Stopping Runtime's emails

Runtime sends no newsletter. Each optional email ends with a link that stops
that kind for you. You can also choose them in an account at
[withruntime.com/account/emails](https://withruntime.com/account/emails) (see
[Emails](./teams#emails)). Email support from an address and ask to stop our
emails. The support agent tells you which of Runtime's emails reach that
address and how to stop each. It only looks. Anyone can put any address on an
email, so stopping takes the email's own link or your signed-in settings.

### What goes to a person

Refunds, credits, disputed charges, security reports, suspected leaked keys,
data loss, outages, abuse reports and legal questions always go to a person. So
does any request for a person, a bug you report from your account, and a
question the support agent cannot finish in one reply. The support agent says so,
and a person replies in the same conversation. If you suspect a key has leaked, revoke it at
[withruntime.com/account/keys](https://withruntime.com/account/keys) first, then
report it.

Support conversations are processed by an AI model through a third-party model
gateway. The providers are listed on the [subprocessors page](/legal/subprocessors).
