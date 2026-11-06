import assert from "node:assert/strict";
import test from "node:test";
import { AI, USER, setup } from "./helpers.ts";

test("state changes supersede old claims without deleting history", async () => {
  const { namiso, say, drain } = await setup();
  await say(USER, "user", "我是一名程序员。");
  await say(AI, "assistant", "你主要写什么语言？");
  await say(USER, "user", "我在使用 TTS-A。");
  await say(AI, "assistant", "它的情感控制怎么样？");
  await say(USER, "user", "我可能还是会换回 IndexTTS2。");
  await say(USER, "user", "我决定重新开始使用 IndexTTS2 了。");
  await drain();

  const details = namiso.getEntityDetails(USER);
  assert.ok(details !== null);
  const uses = details.claims.filter((claim) => claim.predicate === "uses");
  assert.equal(uses.length, 2);
  const active = uses.filter((claim) => claim.status === "active");
  const superseded = uses.filter((claim) => claim.status === "superseded");
  assert.equal(active.length, 1);
  assert.equal(superseded.length, 1);
  assert.equal(active[0]?.object.kind, "entity");
  assert.equal(superseded[0]?.object.kind, "entity");

  const activeEntity = namiso.getEntityDetails(
    active[0]?.object.kind === "entity" ? active[0].object.entityId : "",
  );
  assert.equal(activeEntity?.entity.name, "IndexTTS2");

  const current = await namiso.retrieve({ query: "我现在使用什么模型？" });
  const currentClaims = current.candidates.filter(
    (candidate) => candidate.kind === "claim" && candidate.status === "active",
  );
  assert.ok(currentClaims.length > 0);
  const context = await namiso.getContext({ query: "我现在使用什么模型？" });
  assert.match(context.text, /IndexTTS2/);
  assert.match(context.text, /\[Current Claims\]/);
  assert.doesNotMatch(context.text, /\[claim:[^\]]+\] 用户A uses TTS-A（当前有效）/);

  const history = await namiso.retrieve({ query: "我以前用过什么模型？" });
  const historyClaims = history.candidates.filter((candidate) => candidate.kind === "claim");
  assert.ok(historyClaims.some((candidate) => candidate.status === "superseded"));

  const timeline = namiso.timeline({ entityName: USER });
  assert.deepEqual(
    timeline.map((entry) => entry.event.type),
    ["usage_change", "usage_change"],
  );
  namiso.close();
});

test("uncertain intent does not change current state", async () => {
  const { namiso, say, drain } = await setup();
  await say(USER, "user", "我在使用 TTS-A。");
  await say(USER, "user", "我可能还是会换回 IndexTTS2。");
  await drain();

  const details = namiso.getEntityDetails(USER);
  assert.ok(details !== null);
  const uses = details.claims.filter((claim) => claim.predicate === "uses");
  assert.equal(uses.length, 1);
  assert.equal(uses[0]?.status, "active");
  const objectId = uses[0]?.object.kind === "entity" ? uses[0].object.entityId : "";
  assert.equal(namiso.getEntityDetails(objectId)?.entity.name, "TTS-A");

  const context = await namiso.getContext({ query: "我现在使用什么模型？" });
  assert.match(context.text, /TTS-A/);
  assert.ok(context.uncertainties.some((note) => note.includes("不确定陈述")));
  namiso.close();
});

test("history keeps evidence linked to the original messages", async () => {
  const { namiso, say, drain } = await setup();
  await say(USER, "user", "我住在杭州。");
  await say(USER, "user", "我搬到上海了。");
  await drain();

  const details = namiso.getEntityDetails(USER);
  assert.ok(details !== null);
  const locationClaims = details.claims.filter((claim) => claim.predicate === "location");
  assert.equal(locationClaims.length, 2);
  const current = locationClaims.find((claim) => claim.status === "active");
  assert.ok(current !== undefined);
  const claimDetails = namiso.getClaimDetails(current.id);
  assert.ok(claimDetails !== null);
  assert.equal(claimDetails.evidenceMessageIds.length, 1);
  const message = namiso
    .getMessages()
    .find((item) => item.id === claimDetails.evidenceMessageIds[0]);
  assert.ok(message !== undefined);
  assert.match(message.content, /上海/);
  namiso.close();
});
