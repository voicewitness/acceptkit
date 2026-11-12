# acceptkit

[中文](README.md)

**Acceptance testing done by your coding agent, with verdicts you can trust and re-check.**

Coding agents can already tap through apps, drive browsers and read logs. Ask one to "verify this feature" and a few minutes later it says "verified, passed". The hard part is whether that "passed" can be trusted: did it test the right build on the right device? Is the screenshot the result page or a login dialog? Does "no errors seen" mean there were none, or that it never looked?

acceptkit is a local acceptance-testing toolkit. Your coding agent (Claude Code, Codex, Cursor, Gemini CLI, …) loads `skill/SKILL.md` and runs acceptance tests through it on real apps, browsers and emulators. The tool layer **never calls a model**; it only does what can be computed:

- **No evidence, no pass.** Observations are executed by the tool, saved verbatim and judged by rules. When the agent records something by hand, the text it quotes must be found in the evidence.
- **The executor doesn't review itself.** Every evidence bundle goes to a blind review in a fresh context that only sees the evidence.
- **Human decisions require the human's words.** A person approves which cases run; nothing runs before that. Questions that block execution go into a blocker ledger, and answers are stored as the person's own words. The agent cannot approve on their behalf.
- **Hooks enforce what a manual can't.** Booting or killing devices, installing packages, or editing acceptance records outside acceptkit gets blocked by host hooks.
- **The tool decides what's next.** Each turn the agent asks `next` what is left and does one step from the returned card. All state is on disk, so another session or another agent can pick up where it stopped.

## Compared with other approaches

| Approach | Good at | What it leaves open | What acceptkit adds |
|---|---|---|---|
| Scripted E2E (Appium, Espresso, XCUITest, Playwright, Maestro) | Deterministic, repeatable | Expensive to write and maintain, breaks when the UI changes; new features need new scripts first | Cases are plain-language steps plus assertions that the agent maps onto today's UI; judging still runs in the tool |
| AI test agents that operate the UI and give a verdict | Flexible, no scripts | The verdict is the model's word: no re-checkable evidence, lessons stay in one conversation | Verdicts follow only from saved, re-checkable evidence; lessons become project knowledge and checks |
| Test case management platforms | Organizing cases and status | A case is an abstract sentence; executing and judging is all manual | Cases carry how to observe and where they apply; humans and machines read the same file |

acceptkit doesn't replace the drivers above. It can call them: register your project's build and tap commands, and acceptkit handles cases, evidence, gates and records.

## Quick start

Needs Node 22.5+ and Chrome. This walks the bundled example `examples/web-demo` (a static cart page with "free shipping over 99") from start to a report, in about ten minutes.

```bash
git clone https://github.com/voicewitness/acceptkit.git && cd acceptkit/examples/web-demo
AK="node ../../bin/acceptkit.mjs"
$AK env                                   # what this machine has (Chrome / emulators / adb)
$AK doctor --fix                          # first open: registers the case-quality baseline, tightens knowledge/ permissions
$AK browser "file://$PWD/site/index.html" # an isolated Chrome instance (port 9360); your own browser is untouched

# A plan says what changed and which cases verify it. Only a person may approve it.
$AK plan new DEMO-1 --title "示例需求：满 99 包邮" --platform web
$AK plan add-case DEMO-1 --surface S1 --change "购物车包邮提示" \
  --risk "门槛算错：差一点的用户被收运费，或满额的用户没有免运费" \
  --uncovered "优惠券、多件商品叠加" --reuse cart-free-shipping
$AK plan check DEMO-1
$AK plan approve DEMO-1 --by "<your name>" --quote "<your exact words>"

$AK run cart-free-shipping --demand DEMO-1
RUN=<run id printed above>
$AK observe $RUN
```

Expected: E1, E2, E3 pass (E2 goes through the `demo-diag` channel implemented in `pack.mjs`); E4 is **blocked** as B1, because it requires backend-level evidence (S1) the demo can't provide, and the page-text fallback is only S2.

`report` is refused at this point on purpose: what blocked the run must be told to the owner during execution, not discovered in a report. Write the blocker up and raise it, then report:

```bash
$AK blockers DEMO-1 --set B1 \
  --unlock "接入订单后台的查询接口（在 pack.mjs 里加一个观测通道），让结算运费能直接读到" \
  --review-note "评审时漏了：示例站点没有订单后台，要求的读法从一开始就拿不到"
$AK blockers DEMO-1 --raise               # prints a message ready to send to the owner
$AK report $RUN                           # runs/<run id>/run.md: PARTIAL, 3 pass, 1 blocked
```

To start over, delete `.acceptkit/`, `runs/` and `state/` in the example directory. Close the browser window from the `browser` step when done.

## Vocabulary

The CLI and docs are in Chinese; these are the terms you'll meet first.

| Term | Meaning |
|---|---|
| demand (需求) | One change to accept, e.g. "free shipping over 99" |
| case / assertion (用例 / 断言) | A case is a tree of steps; each step carries assertions that say how to observe and what counts as passing |
| plan (评审单) | Which cases this demand runs. Nothing runs until a person approves it |
| run (运行) | One execution of one case; its evidence lives in its directory |
| blind review (盲审) | A fresh context that sees only the evidence bundle and judges whether it's enough |
| blocker (阻塞) | Something execution is stuck on that needs a person's answer or an outside condition |
| gate (闸门) | A check the tool enforces before touching a device or recording a verdict |
| card (卡片) | What `next` returns: the next thing to do |
| owner | The person responsible for the demand, who makes the calls; the executor is the agent |
| pack | A project's private extension: private observation channels, target resolution, domain commands |

## Support

| | |
|---|---|
| Web | Chrome via CDP, in an isolated debug instance that doesn't touch your main browser. Outside macOS it looks for `google-chrome`; override with `CHROME_BIN` |
| Android | Devices or emulators, needs `adb` |
| iOS | Simulators, needs Xcode (`xcrun simctl`) |
| Screenshot text recognition | macOS only (Vision) |
| Host hooks | Claude Code, Codex, Gemini CLI, Cursor (`acceptkit hook install --host …`) |
| Runtime | Node 22.5+, no third-party dependencies. Verified on macOS only so far |

While in 0.x, commands and file formats may still change.

## Your own project

A project is a directory, kept outside this repo:

- `acceptkit.project.json`: allowed devices / packages / tenants (anything else is refused), app under test
- `cases/`: cases
- `ops/registry.json`: how each observation is performed
- `knowledge/`: plain Markdown; values tagged `#secret` never appear in evidence or reports
- `pack.mjs` (optional): private extensions; see `examples/web-demo/pack.mjs`

Create one with `node bin/acceptkit.mjs project init <dir>`. Design docs (in Chinese) start at [docs/000-philosophy.md](docs/000-philosophy.md).

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md) and [SECURITY](SECURITY.md).

## License

Apache-2.0
