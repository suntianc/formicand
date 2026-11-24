import { test, expect } from "@playwright/test";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";

function turn(index) {
  const timestamp = 1700000000000 + index * 2000;
  const user = { role: "user", id: "u" + index, content: "Question " + index, timestamp };
  const answer = {
    role: "assistant",
    id: "a" + index,
    content: "Answer " + index + "\n\n" + "Paragraph. ".repeat(100),
    timestamp: timestamp + 100,
    stopReason: "stop"
  };
  return (
    [user, answer]
      .flatMap((message) => ["message_start", "message_end"].map((type) => JSON.stringify({ type, message })))
      .join("\n") + "\n"
  );
}

const known = (p, limit = p.limit) =>
  [
    limit,
    p.limit,
    p.stamp || "-",
    p.messageCount,
    p.eventCount,
    p.digest,
    p.oldestTime || 0,
    p.oldestRun || "-"
  ].join(";");

for (const layout of ["separate Runs", "one resident Run"]) {
  test("paging preserves every turn and the scroll anchor in " + layout, async ({ page }) => {
    const dashboard = await startDashboard();
    try {
      const url = dashboard.base + "/api/tasks/paging";
      const created = await page.request.post(dashboard.base + "/api/tasks", {
        data: { taskId: "paging", goal: "History paging", projectId: dashboard.projectId }
      });
      expect(created.ok()).toBe(true);
      const base = join(dashboard.workspaceRoot, "paging", "runs");
      const file = (i) =>
        join(
          base,
          layout === "one resident Run" ? "resident" : "r" + String(i).padStart(3, "0"),
          "runtime-output.log"
        );
      for (let i = 0; i < 32; i++) {
        const root = join(file(i), "..");
        await mkdir(root, { recursive: true });
        if (layout === "separate Runs" || i === 0)
          await writeFile(
            join(root, "run.json"),
            JSON.stringify({ createdAt: new Date(1700000000000 + i * 2000).toISOString() })
          );
        await appendFile(
          file(i),
          turn(i) + (layout === "one resident Run" ? "diagnostic".padEnd(36000, " ") + "\r\n" : "")
        );
      }
      if (layout === "separate Runs") {
        for (let i = 32; i < 47; i++) {
          const dir = join(base, "maintenance-" + i);
          await mkdir(dir);
          await writeFile(
            join(dir, "run.json"),
            JSON.stringify({ createdAt: new Date(1700000000000 + i * 2000).toISOString() })
          );
        }
      }
      const get = async (header) =>
        (await page.request.get(url, { headers: header ? { "x-atria-history": header } : {} })).json();
      const full = await get(),
        first = await get("12");
      const users = (d) => d.messages.filter((m) => m.role === "user").map((m) => m.content);
      expect(users(first)).toEqual(users(full).slice(-12));
      expect(first.historyPage.hasMore).toBe(true);
      const idle = await get(known(first.historyPage));
      expect(idle.historyPage.mode).toBe("unchanged");
      expect(idle).not.toHaveProperty("runtimeEvents");
      const delta = await (
        await page.request.get(url, {
          headers: {
            "x-atria-history": known(first.historyPage),
            "x-atria-detail-revision": first.metadataPatch.revision
          }
        })
      ).json();
      expect(delta.metadataPatch.base).toBe(first.metadataPatch.revision);
      expect(delta).not.toHaveProperty("task");
      expect(delta).not.toHaveProperty("messages");
      expect(delta).not.toHaveProperty("events");
      const earlier = await get(known(first.historyPage, 24));
      expect(earlier.historyPage.mode).toBe("prepend");
      expect([...users(earlier), ...users(first)]).toEqual(users(full).slice(-24));
      const last = await get(known(earlier.historyPage, 36));
      expect(last.historyPage.hasMore).toBe(false);
      expect([...last.runtimeEvents, ...earlier.runtimeEvents, ...first.runtimeEvents]).toEqual(
        full.runtimeEvents
      );
      expect([...last.messages, ...earlier.messages, ...first.messages]).toEqual(full.messages);

      await page.goto(dashboard.base);
      const scroll = page.locator("#conversation");
      await expect(scroll.locator(".chat-message.user")).toHaveCount(12);
      await expect(scroll).toContainText("Question 31");
      const incoming = page.waitForResponse(
        (r) => r.url() === url && r.request().headers()["x-atria-history"]?.startsWith("24;")
      );
      const before = await scroll.evaluate((node) => {
        node.scrollTop = 0;
        const user = node.querySelector(".chat-message.user");
        return { key: user.dataset.historyMessage, top: user.getBoundingClientRect().top };
      });
      await incoming;
      await expect(scroll.locator(".chat-message.user")).toHaveCount(24);
      const after = await scroll.locator('[data-history-message="' + before.key + '"]').boundingBox();
      expect(Math.abs(after.y - before.top)).toBeLessThan(3);
      const secondAnchor = await scroll.evaluate((node) => {
        node.scrollTop = 0;
        const user = node.querySelector(".chat-message.user");
        return { key: user.dataset.historyMessage, top: user.getBoundingClientRect().top };
      });
      await expect(scroll.locator(".chat-message.user")).toHaveCount(32);
      // Let the virtual list finish hydrating the new viewport before measuring it.
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      );
      const restored = scroll.locator('[data-history-message="' + secondAnchor.key + '"]');
      await expect
        .poll(async () => Math.abs((await restored.boundingBox())?.y - secondAnchor.top))
        .toBeLessThan(3);
      await expect(page.locator("#earlier-conversation")).toBeHidden();
      await appendFile(file(31), turn(32));
      const changed = await get(known(first.historyPage));
      expect(changed.historyPage.mode).not.toBe("unchanged");
      const afterAppend =
        changed.historyPage.mode === "append" ? [...users(first), ...users(changed)] : users(changed);
      expect(afterAppend).toEqual([...users(first), "Question 32"]);
    } finally {
      await dashboard.stop();
    }
  });
}
