import assert from "node:assert/strict";
import { test } from "vitest";
import { USER, setup } from "./helpers.ts";

test("forgetting a message removes its evidence from retrieval", async () => {
  const { namiso, say, drain } = await setup();
  await say(USER, "user", "我的秘密代号是 Bluefin-7。");
  await drain();
  const before = await namiso.retrieve({ query: "Bluefin-7", rerank: false });
  assert.ok(before.candidates.length > 0);

  const message = namiso.getMessages()[0];
  assert.ok(message !== undefined);
  const report = await namiso.forget({ scope: "message", messageIds: [message.id] });
  assert.equal(report.deletedMessages, 1);
  assert.equal(namiso.health().counts.messages, 0);
  assert.equal(namiso.health().counts.chunks, 0);
  const after = await namiso.retrieve({ query: "Bluefin-7", rerank: false });
  assert.ok(
    after.candidates.every(
      (candidate) => candidate.record.kind !== "message" && !candidate.text.includes("Bluefin-7"),
    ),
  );
  namiso.close();
});

test("forgetting an entity removes its claims", async () => {
  const { namiso, say, drain } = await setup();
  const friendName = "小岑";
  await say(USER, "user", `${friendName}是我的朋友。`);
  await drain();
  const user = namiso.getEntityDetails(USER);
  assert.ok(user !== null);
  const friendClaim = user.claims.find((claim) => claim.predicate === "friend_of");
  assert.ok(friendClaim !== undefined);
  assert.equal(friendClaim.object.kind, "entity");
  const friendId = friendClaim.object.kind === "entity" ? friendClaim.object.entityId : "";
  const friend = namiso.getEntityDetails(friendId);
  assert.ok(friend !== null);

  const report = await namiso.forget({ scope: "entity", entityId: friendId });
  assert.equal(report.deletedEntities, 1);
  assert.equal(namiso.getEntityDetails(friendId), null);
  const details = namiso.getEntityDetails(USER);
  assert.ok(details !== null);
  assert.equal(details.claims.filter((claim) => claim.predicate === "friend_of").length, 0);
  namiso.close();
});

test("forgetting a conversation removes its messages", async () => {
  const { namiso, conversation, say, drain } = await setup();
  await say(USER, "user", "这条消息会被整段删除。");
  await drain();
  const report = await namiso.forget({
    scope: "conversation",
    conversationId: conversation.id,
  });
  assert.equal(report.deletedConversations, 1);
  assert.equal(namiso.getMessages().length, 0);
  assert.equal(namiso.health().counts.messages, 0);
  namiso.close();
});
