# Visualiser animation: the diff-based system, where it broke, and the timeline model that replaced it

This document is for anyone touching `src/visualiser/Bodies.ts`, `Timeline.ts`, `GameRenderer.ts`, `Match.ts` or a dragon skin. Part 1 describes the previous system, which inferred motion from state diffs. Part 2 lists what was wrong with it, with numbers from the two replays in the repo. Part 3 describes what replaced it: a per-round **timeline compiled from events**, which represents multi-step moves, splits, deaths and dragons weaving through each other's cells without inference.

---

## Part 1 — The previous system (diff-based)

### 1.1 One principle: every frame is `f(prev, next, t)`

Nothing in the visualiser animates an event. Events are only state mutations (`Round.applyEvents` forwards each to `CurrentMap.applyEvent` and `Bodies.applyEvent`). Animation is a **diff of two settled states**: `Match.frameAt(position)` returns `{ prev, next, t }`, and the tweeners in `Bodies.ts` and `Map.ts` reconstruct what "must have happened" by comparing the same dragon, or the same tile, in the two states.

The float `position` is owned by `GameRunner`; its integer part selects a step, its fraction is `t`. A step is a *boundary pair* in the chosen granularity (`round`, `turn`, `event`). Finer granularities tween between *partial rounds* built by applying a prefix of the round's events (`Match.partialRound`).

### 1.2 What the tweener infers from a diff

For a dragon present in both states (`dragonView` in `Bodies.ts`):

| Inferred quantity | How | Used for |
|---|---|---|
| `headSteps` | index of `prev`'s head cell inside `next`'s body | head glide distance, in cells |
| `vacated` | cells of `prev`'s body behind the position of `next`'s settled tail | tail retraction path |
| growth | `vacated` is empty | tail stays put |
| spawn | no `prev` | alpha fade-in over the first half of the step |
| death | in `prev`, not in `next` | frozen at `prev` pose, alpha fade, red tint, head-first `dissolve` |

Body + vacated cells are laid out as one continuous polyline in "spine space" with a per-vertex board offset (`buildSpine`), so a body straddling a wrap seam or portal is one curve. Corners are rounded into 24-sample arcs; the head end is trimmed by `(1 − t) · markers[headSteps]` and the tail end toward `markers[body.length − 1]`; the trimmed curve is cut back into board-space runs at the crossings (`toBoardSpace`). Head direction is the chord over the last 4 samples; tail direction is an explicit arc around the tile corner it turns through.

Pearls (`pearlViews`) diff `prev.tiles` against `next.tiles` per cell: gained → grow with `easeOutCubic(t)`, lost → shrink.

### 1.3 What the skins receive

A `DragonView`: `segments` (board-space polylines), `cells` (settled body), `head`/`headDir`, `tail`/`tailDir`, a single optional `vacatedTail`, `alpha`, `tint`, `dissolve`, `t`, `moveT`, `headMoved`. The sprite skin (`createSpriteDragonSkin`) ignores `segments` and re-derives everything from `cells + vacatedTail` via `classifyBody`, then wipes the two end cells by `t` and rides head/tail sprites along `head`/`tail`.

---

## Part 2 — Findings against the previous system

### 2.1 Execution errors: none found

Evidence gathered on this branch. The replays it was measured against are
not in the repo — none are committed — so the counts below are a record of
those runs, not something a clone can reproduce without recording its own.

- `deno task test` in `packages/visualiser`: 23/23 pass. (`npx vitest` fails with `Deno is not defined` — the suite is Deno-only; that is tooling, not a code bug.)
- Headless Chromium driving the real client: a 500-round gauntlet match (34 915 events, 132 splits, 223 multi-step turns, 109 deaths) played at 12× through all three granularities, scrubbed end to end, through the Sea Dragon skin. **0 exceptions, 0 console errors.**
- A Deno harness that tweened every step of both replays at six `t` values and every granularity, checking for NaN geometry, empty segments and thrown errors: nothing.

The system is numerically robust. Everything below is *wrong motion*, not crashes.

### 2.2 Visual bugs present now

Counts are from that gauntlet match at round granularity unless stated.

| # | Bug | Where | Evidence |
|---|---|---|---|
| B1 | **Detached tail on multi-step moves.** The sprite skin extends the body by a single `vacatedTail`, but a two-step move vacates two or three cells. Intermediate vacated cells are drawn empty while the tail sprite follows the geometric path through them, so the tail floats a cell or more away from the body. `classifyBody` cannot connect the non-adjacent `vacatedTail`, so it also gets the `facing` fallback rotation. | `Skins.ts` `drawSmoothMove`: `extended = [...cells, vacatedTail]` | 310 multi-cell retracts; 302 have `vacatedTail` not adjacent to the body; 442 vacated cells never drawn. Screenshot: round 24, dragon 5. |
| B2 | **Split animates as motion.** The parent's donated cells sit behind its new tail, so they are read as `vacated` and the parent's tail *retracts across the child's body* while the child fades in on the same cells. Two dragons are drawn on the same cells for the whole step, with wipe rectangles visible where they overlap. | `dragonView` vacated inference | All 132 splits. Screenshot: round 28, parent 5 → child 8. |
| B3 | **Cell hand-offs draw both dragons in the cell at once.** When B's head enters a cell A's tail left this round, both are tweened over the same `0..1`, so they overlap in the middle of the step. Z-order is spawn order, not who arrived last. | `dragonViews` iteration order | 71 hand-off rounds. Screenshot: round 86, dragon 17 over dragon 16. |
| B4 | **Mid-move deaths freeze the wrong pose.** A dragon that stepped once then died on its second step is drawn dying at its *pre-move* body; the pearls it dropped land on its *at-death* body. | dying view built from `prev` | 21 mid-move deaths; drawn corpse differs from the death pose by 31 cells in total. |
| B5 | **Head-to-head kills never show contact.** Both dragons freeze and fade at their previous poses; the attacker's head never reaches the contested cell. | same as B4 | every reason `H` death |
| B6 | **Sonar has no board visual** despite the event carrying `origin`, `end`, `hitId`. | not consumed by `GameRenderer` | 177 pings in the 52-round sample match |
| B7 | **Overlay is per round, not per time.** Debug draws and indicators switch when the round changes, even at event granularity where the events they belong to have not happened yet. | `Visualiser.svelte` `overlayFor` | — |
| B8 | **Long moves snap.** A head that moved further than the body it left behind glides `body.length − 1` cells and snaps the rest; the tail snaps entirely when its settled cell is not in the previous body. | `Math.min(headSteps, body.length − 1)` | short dragons sprinting |

Latent, not observed: `Bodies.applyEvent('dragonUpdate')` pops the tail until it *equals* the declared tail; an inconsistent stream (declared tail not in body) collapses the dragon to its head.

### 2.3 Foundational assumptions that do not hold

The bugs above are not independent. They follow from assumptions baked into "diff two snapshots":

| Assumption | Violated by | Symptom |
|---|---|---|
| A1. *Cells in `prev` but not behind the new tail were vacated by movement.* | splits transfer cells to another dragon | B2 |
| A2. *A dragon moves at most one cell per step, and skins only need the last vacated cell.* | multi-step moves (2 per turn in play) | B1, B8 |
| A3. *All dragons move simultaneously across the step.* | the engine resolves turns sequentially in spawn order; hand-offs and head-to-heads are only meaningful in that order | B3, B5 |
| A4. *A dragon absent from `next` was in its `prev` pose when it died.* | deaths mid-move; the event stream knows the true pose | B4, B5 |
| A5. *The step is the unit of time; nothing inside a round has a time.* | every event has a position in the round; pearls eaten mid-turn, draws issued per turn | B6, B7 |
| A6. *Dragons can be drawn independently of each other.* | cells with two occupants during a step | B3 |
| A7. *Finer granularities need separate state machinery (partial rounds).* | granularity is just a narrower time window on the same motion | duplicated logic; snapping differs by granularity |

The good parts to keep: the spine-with-offsets geometry (seams and portals as one curve), the corner arc / tail-pivot maths, the cached board layer, the skin blit primitives and the `f(state, t)` purity that makes scrubbing free.

---

## Part 3 — The timeline model (implemented)

### 3.1 Principle

**Compile, don't infer.** `Match.timeline(round, stagger)` compiles a round's event list once into a `RoundTimeline` (`src/visualiser/Timeline.ts`): per-dragon **tracks** of segments on a local clock `τ ∈ [0, 1]`, plus pearl changes, bot effects and sonar pings. A frame is a pure sample `timeline.views(τ, cell)`. Every fact the old tweener guessed is stated by an event, so the compiler reads it instead.

```
events (one round) ──compile──▶ RoundTimeline { dragons: Map<id, DragonTrack>, pearls, effects, pings, turns, slots }
position (float)   ──map──────▶ TimelineFrame { round, tau, timeline, window }     // Match.frameAt
timeline.views(τ)  ──────────▶ DragonView[] in draw order                          // layoutDragon per sample
```

### 3.2 Time layout inside a round

The engine processes turns in spawn order and marks the last event of each (`EventLevel.Turn`); trailing events (pearl respawns) form the round's end group. The compiler lays the groups on `τ` with a **stagger** `s ∈ [0, 1]` (`GameRunner.stagger`, the TURNS control):

- `s = 0` (TOGETHER, the default): every group owns `[0, 1)`, so in continuous playback every dragon moves across the whole round at constant speed and the motion flows. Hand-offs overlap briefly but draw in arrival order (3.5).
- `s = 0.35` (STAGGERED): groups overlap but keep their order, so a hand-off reads as "A leaves, then B enters". Each dragon now moves in a burst and rests for the remainder of the round; the bursts are eased in and out (smoothstep) so they start and stop without a jolt.
- `s = 1` (IN ORDER): group `k` of `n` owns `[k/n, (k+1)/n)`. Exactly the engine's order; no cell ever has two living occupants. Bursts are short, so this is for stepping and study rather than watching.

Slides are otherwise linear in time. The only easing curves in the system are the burst easing above, the pearl grow/shrink (`easeOutCubic`) and the death tint.

Within a group, the **timed events** (`dragonUpdate`, `dragonDeath`, `dragonSplit`, `dragonCreate`) split its window into equal **slots**; two head-on deaths in a row share one. A multi-step move is two consecutive slots, so the head glides through the intermediate cell and the tail through every vacated cell. Untimed events attach to a slot: an eaten pearl shrinks with the step that eats it, a dropped pearl grows with the death that drops it, drawings and indicators appear when their turn starts, a sonar pulse plays with the move before it.

Granularity is a **window** onto the same clock. `round` plays `[0, 1)` with the runner's stagger; `turn` plays one group's window and `event` one slot's window, both from the round laid out strictly in order so whole-number positions land on settled states. `Match.partialRound` and the per-event step boundaries are gone; `appliedEvents` and `stepShowing` (used by the game log) are answered from the windows.

### 3.3 Track segments

```ts
type DragonSegment =
  | { kind: 'slide'; at: Window; facing; after: Cell[]; steps: { at: Window; leave: Cell[] }[] }  // one turn's movement
  | { kind: 'born';  at: Window; facing; body: Cell[]; fromSplit: boolean }
  | { kind: 'split'; at: Window; before: Cell[]; after: Cell[]; childId }  // parent side: cells change owner, no motion
  | { kind: 'die';   at: Window; facing; body: Cell[]; reason?; contact?: Cell };
```

| Event | Compiles to | Fixes |
|---|---|---|
| `dragonUpdate` | a `slide` step; consecutive updates in one turn extend the same slide, so a multi-step move is one continuous glide with a slot per step | B1, B8 |
| `tileChange` Pearl→Empty | pearl `shrink` on the slot after it (the step that ate it) | — |
| `tileChange` Empty→Pearl | pearl `grow` on the slot before it (the death or respawn) | B4 |
| `dragonSplit` | parent `split` + child `born { fromSplit }`: zero motion. Over the slot the whole old body fades out while the parent's kept body and the child fade in, a crossfade from one dragon to two | B2 |
| `dragonCreate` | `born`: alpha pop-in | — |
| `dragonDeath` | `die` with the body as of that event; `contact` is the partner's head for a head-on kill, which the other death states, and unset otherwise — see 3.5 | B4, B5 |
| `sonarPing` | `ping` with the `path` the engine's cast took (retraced with `stepFrom`: through portals, round the wrap, ending short of kelp or on the dragon hit); drawn as wave crests running along it | B6 |
| `debugDraw`, `dragonIndicator` | `effects` at their turn's start | B7 |
| logs, `pearlSpawnAttempt` | nothing (log only) | — |

### 3.4 Sampling → `DragonMotion` → `DragonView`

`timeline.sample(track, τ)` walks the track and yields a `DragonMotion` (`Bodies.ts`): the `cells` the body settles on, `headSteps` + `headProgress` (how many cells the head enters this turn and how far through them it is) or a dying `contact`/`contactAdvance`, and `leave` + `tailToGo` (cells the tail tip still has to travel). `layoutDragon` turns it into geometry, reusing the spine-with-offsets curve, corner arcs and the tail-pivot sweep unchanged, and produces the view's **occupancy**:

```ts
occupancy: { cell; from; to }[]   // every cell the dragon touches, head end first;
                                   // from/to = body-art coverage along the flow, 0 tail side → 1 head side
```

The rule behind every number: **body art ends half a cell short of each tip; the cap sprite covers that half cell.** A cell an end cap sits in has empty coverage. Any number of cells at either end can be partial, which is what a two-step move, a dissolving corpse and a bumping head all need.

Both caps use the same construction (`sweepCut`): the body's cut through the cell an end is crossing moves from the side the body entered by to the side it leaves by, straight across for a straight run and around the tile corner (radius `CORNER_RADIUS`) for a bend, and the cap sits half a cell along the tangent from the cut, ahead of it for the head and behind it for the tail. That puts each cap exactly on a cell centre at both ends of every step, keeps it flush with the radial wipe the corner art makes, and turns it smoothly through the bend. It is computed in spine space, so a cap crossing a portal or the wrap seam lands on the far side correctly.

`vacatedTail`, `headMoved` and `t` are gone from `DragonView`. The sprite skin has one drawing path: classify the occupancy cells, wipe each to its coverage, blit the caps at `head`/`tail`. The pixel skin fills cells with any coverage or an end in them.

### 3.5 Weaving

- **Order by arrival.** `timeline.samples(τ)` sorts dying dragons first, then living ones by the τ at which they last entered a cell. The dragon entering a cell is drawn over the one leaving it.
- **Sequential when asked.** At `s = 1` no living cell is shared at any τ (a test asserts this over every replay given). At the default `s = 0` the two dragons overlap in the shared cell for the middle of the round, drawn in the right order.
- **Portals and seams unchanged.** A crossing is a slide whose `enter` cell is elsewhere; occupancy lists both cells with their fractions and the spine cuts the curve at the boundary.
- **Head-on contact.** Both `die` segments share a slot; the attacker's head bumps `CONTACT_BUMP` (half a cell) toward the partner's head over the first `CONTACT_SHARE` of the window, then both dissolve head-first.
- **Every other death dissolves where it stands.** `dragonDeath` carries `{id, reason}` only: the engine assigns the fatal direction (`dragon.mFacing = step` in `ApplySingleStep`) and then kills the dragon without pushing the step, so the cell the head was entering never reaches the client. A head-on kill is the one case the stream still states it, because the partner's own death carries that head. Nothing else is inferred — an earlier version reconstructed the cell from the death reason, and 51 of the 83 non-head-on deaths in that gauntlet match had two or three cells consistent with their reason, so the lunge it drew was a coin flip that could send a corpse into a dragon it never touched. A death with no stated contact tints, fades and dissolves head-first in place, which is true whatever it hit. `Timeline.test.ts` asserts no other death claims a contact cell. To bring the bump back for every death, add the fatal direction to `EventDragonDeath` (engine `event.h`, `engine/replay.capnp`, `capnpCodec.ts`) rather than guessing it here.

Not done: clipping two occupants of one cell against each other. Ordering makes the cap of the arriving head cover the departing tail, which reads correctly at every stagger tested; a per-cell two-occupant clip would only matter for vector skins that draw translucent bodies.

### 3.6 Invariants (in `Timeline.test.ts`, over whatever replays `REPLAYS` names)

1. **Connectedness:** consecutive occupancy cells are one `stepBetween` apart at every τ (kills B1).
2. **Continuity:** heads and tails move less than a cell between fine τ samples, except across a seam or portal.
3. **Exclusivity at `s = 1`:** no cell has two living occupants (kills B3 as a correctness check).
4. **Splits are still:** parent and child poses are identical across the split's window, and mid-window the old body, the parent and the child are each at half opacity (kills B2).
5. **Deaths at the truth:** the `die` body equals the engine's state at the event, and the pearls it drops appear with it on that body (kills B4).
6. **Granularity agreement:** a turn or event window samples the same poses as the whole round in order.
7. **Settled steps:** every whole-number round or turn position puts every living head and tail on a cell centre (an event step inside a multi-step move deliberately stops mid-glide).
9. **Multi-step continuity:** a two-step turn moves the head through the shared cell without a jump, and the head cap stays a fixed distance from a corner's pivot throughout the bend.
8. **Head-on:** both deaths share a window and the attacker reaches the shared boundary.
10. **Sonar path:** a ping's path retraces the engine's cast through a portal and stops short of kelp.

### 3.7 Files

| File | Role |
|---|---|
| `Timeline.ts` | compile events → tracks; sample (with split ghosts); pearls; effects; sonar paths; `stepFrom` |
| `Bodies.ts` | `Dragon`/`Bodies` state; `DragonMotion` → `layoutDragon` → `DragonView` with `occupancy`; `classifyBody` |
| `Match.ts` | snapshots + cached timelines; positions ↔ (round, τ) via windows; `frameAt`, `positionOf`, `appliedEvents`, `stepShowing` |
| `GameRunner.svelte.ts` | float position, `stagger` |
| `GameRenderer.ts` | `draw(frame)`: board cache, pearls, sonar, dragons in draw order, overlay |
| `Skins.ts` | pixel and sprite skins read `occupancy` |
| `Visualiser.svelte` | TURNS control, hit-testing via `timeline.cellsAt` |
