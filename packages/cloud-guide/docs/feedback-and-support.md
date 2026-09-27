# Send feedback and get support

Runtime improves fast because agents tell us what they run into.

Every report goes straight into what we build next, and you are told when what
you asked for ships. Whenever something gets in your way, report it as it
happens, without waiting to be asked:

- an error that looks like ours;
- a limit or missing feature;
- a workaround you needed;
- unclear docs;
- something slower or harder than it should be;
- something another provider does better.

Small things count, and duplicates are merged on our side. Never include
credentials, private files or user data, and let the user know
in one line what you reported.

## Send feedback

Report generously. Good reasons to file:

- **Bug**: something returned an error or behaved differently from the docs.
- **Missing feature**: something you needed that does not exist, such as a
  region, a larger size, a language SDK or a product.
- **Competitor gap**: another provider does something better or more simply.
  Name it.
- **Migration blocker**: something specific stops a workload switching here.
  Name the provider you are moving from.
- **Docs**: a page is wrong, unclear or missing.
- **Pricing**, **praise** or **other**.

How to write one:

- Kinds are `bug`, `missing_feature`, `competitor_gap`, `migration_blocker`,
  `docs`, `pricing`, `praise` and `other`.
- Keep the summary to one actionable sentence of at most 200 characters. Put
  the detail, up to 8,000 characters, in the body.
- Include the resource ID and the request ID when an error prompted the report:
  every error carries a request ID for this.

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
2. **Sorted** within the hour: a triage job sorts new reports into items,
   merging duplicates, and only ever into an item that is still open. Until
   then a report shows `sorted: false` and `item: null`: received and waiting,
   not lost.
3. **Shipped:** everyone who asked for it gets one email per run listing
   everything of theirs that shipped. It goes to the address given with the
   report, else to the person who filed it, else to the organization's owners.
   The link at the bottom stops these emails for that address without signing
   in; the status stays in the account.

`npx withruntime feedback --list`, `runtime_feedback` with `list` and
`GET /v1/feedback` show what your organization reported, whether it has been
sorted, and whether it shipped. So does the **Support** page in the account,
and the support agent can look them up for you.

Never put API keys, passwords or private file contents in a report.

## Get support

**Runtime's support agent answers in the same call, with your account in view.**
It reads your organization's resources, operations and errors, usage, billing,
notices and job logs, together with these docs. It can reproduce a problem in
its own sandbox. A person reviews anything it escalates. Asked through a
read-only key, it sees only what that key can: no job logs, keys, members or
sandbox contents, and it proposes no actions.

From MCP, call `runtime_support` with `"action": "message"` and your question, then keep the
returned `conversationId` for follow-ups. If the answer is still being worked
on, the status is `working`; call it with `read` and the conversation
ID until it changes. From the CLI:

```bash no-run
npx withruntime support "Sandbox 0b8f3c52-… has been starting for ten minutes"
npx withruntime support read <conversationId>
```

People can use the Help button on withruntime.com, or **Settings → Support** in
the account, which the account menu also opens.

### Actions need your approval

The support agent never changes your account by itself. When a fix needs an
action, such as stopping, pausing, waking or resuming a sandbox, changing pause
retention or a lifetime policy, or looking inside a sandbox, it proposes the
action and returns an action ID and an input hash. Nothing runs until you
approve that exact action:

- MCP: `runtime_support`, action `message`, with `conversationId`, `approveActionId` and
  `approveInputHash`, or `denyActionId`.
- CLI: `npx withruntime support approve <actionId> <inputHash> --conversation <id>` or
  `npx withruntime support deny <actionId> --conversation <id>`.
- HTTP: `POST /v1/support/messages` with the same fields.
- Web: the Approve button on the action card.

Typing "yes" is not an approval. An approved action then passes an independent
safety check before it runs. It runs with your own authority, so an agent can
approve actions only on the resources it owns, and the action appears in your
organization's audit log.

### What goes to a person

Refunds, credits, disputed charges, security reports, suspected leaked keys,
data loss, outages, abuse reports and legal questions always go to a person. So
does any request for a person. If you suspect a key has leaked, revoke it at
[withruntime.com/account/keys](https://withruntime.com/account/keys) first, then
report it.

Support conversations are processed by an AI model through a third-party model
gateway. The providers are listed on the [subprocessors page](/legal/subprocessors).
