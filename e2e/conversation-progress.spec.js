import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("follow-up opens an assistant message before inference and animates each thinking step", async ({
  page
}) => {
  test.setTimeout(90_000);
  let requestCount = 0;
  const gates = [0, 1, 2, 3].map(() => {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    return { promise, release };
  });
  const errors = [];
  const provider = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.end('{"data":[]}');
      return;
    }
    for await (const _chunk of req) {
      /* drain request */
    }
    const current = ++requestCount;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: `progress-${current}`, object: "chat.completion.chunk", model: "browser-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      );
    send({ role: "assistant" });
    if (current === 1) {
      send({ content: "第一轮回答已完成。" });
      send({}, "stop");
    } else if (current === 2) {
      send({ reasoning_content: "**" });
      await gates[2].promise;
      send({ reasoning_content: "先查看可用工具。**" });
      await gates[0].promise;
      send({
        tool_calls: [
          {
            index: 0,
            id: "inspect-tools",
            type: "function",
            function: { name: "enable_tools", arguments: "{}" }
          }
        ]
      });
      send({}, "tool_calls");
    } else {
      send({ reasoning_content: "**" });
      await gates[3].promise;
      send({ reasoning_content: "根据工具信息继续思考。**" });
      await gates[1].promise;
      send({ content: "追问回答已完成。" });
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let dashboard, releaseSubmission;
  try {
    dashboard = await startDashboard({ modelEndpoint: `http://127.0.0.1:${provider.address().port}/v1` });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
    await page.goto(dashboard.base);
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("先回答一次");
    await page.locator("#send-button").click();
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("第一轮回答已完成。", {
      timeout: 30_000
    });
    const holdSubmission = new Promise((resolve) => {
      releaseSubmission = resolve;
    });
    await page.route("**/api/tasks/*/run", async (route) => {
      await holdSubmission;
      await route.continue();
    });
    await page.locator("#composer-input").fill("继续追问，看看工具");
    await page.locator("#send-button").click();
    const pending = page.locator('[data-answer-kind="pending"]');
    await expect(pending).toContainText("思考中");
    await expect(pending.locator(".thinking-spinner")).toBeVisible();
    await expect(page.locator('[data-answer-kind="final"]')).toContainText("第一轮回答已完成。");
    await expect(page.locator(".chat-message.user").last()).toContainText("继续追问");
    expect(requestCount).toBe(1);
    expect(
      await pending.locator(".thinking-spinner").evaluate((el) => getComputedStyle(el).animationName)
    ).toBe("none");
    const frames = pending.locator(".thinking-spinner .ant-frames");
    await expect(frames).toHaveCSS("animation-name", "ant-frames");
    await expect(frames).toHaveCSS("animation-duration", "1.2s");
    await expect(frames).toHaveCSS("animation-timing-function", "steps(24)");
    await expect(frames).toHaveCSS("animation-iteration-count", "infinite");
    const frameCount = await frames.evaluate(async (el) => {
      const strip = new Image();
      strip.src = getComputedStyle(el).maskImage.match(/url\("([^"]+)"\)/)[1];
      await strip.decode();
      return strip.naturalWidth / strip.naturalHeight;
    });
    expect(frameCount).toBe(24);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(frames).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const thinkingSize = await pending
      .getByText("思考中", { exact: true })
      .evaluate((node) => getComputedStyle(node).fontSize);
    releaseSubmission();
    const partialLabel = pending
      .locator(".reasoning-step .assistant-thinking")
      .getByText("思考中", { exact: true });
    await expect(partialLabel).toHaveCSS("font-size", thinkingSize);
    gates[2].release();
    const liveProcess = pending.locator(".process-segment.is-live");
    await expect(liveProcess).toBeVisible({ timeout: 30_000 });
    await expect(liveProcess).not.toHaveAttribute("open", "");
    await expect(liveProcess.locator(":scope > summary")).toContainText("思考中");
    await expect(liveProcess.locator(":scope > summary .thinking-spinner")).toHaveCount(1);
    await liveProcess.locator(":scope > summary").click();
    await expect(pending.locator(".reasoning-copy")).toHaveCSS("font-size", thinkingSize);
    await expect(pending.locator(".reasoning-step")).toContainText("先查看可用工具。", { timeout: 30_000 });
    await expect(liveProcess.locator(":scope > summary .thinking-spinner")).toHaveCount(1);
    gates[0].release();
    await expect(pending.locator(".reasoning-step")).toHaveCount(2, { timeout: 30_000 });
    await expect(pending.locator(".reasoning-step").first()).toContainText("先查看可用工具。");
    await expect(pending.locator(".reasoning-step").first().locator(".thinking-spinner")).toHaveCount(0);
    await expect(pending.locator(".reasoning-step").last().locator(".thinking-spinner")).toBeVisible();
    gates[3].release();
    await expect(pending.locator(".reasoning-step").last()).toContainText("根据工具信息继续思考。");
    await expect(liveProcess.locator(":scope > summary .thinking-spinner")).toHaveCount(1);
    gates[1].release();
    await expect(page.locator('[data-answer-kind="final"]').last()).toContainText("追问回答已完成。", {
      timeout: 30_000
    });
    await expect(pending).toHaveCount(0);
    await expect(page.locator("#conversation .thinking-spinner")).toHaveCount(0);
    await page.route("**/api/tasks/*/run", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"测试发送失败"}' })
    );
    await page.locator("#composer-input").fill("失败后保留草稿");
    await page.locator("#send-button").click();
    await expect(page.locator("#toast")).toContainText("发送失败");
    await expect(pending).toHaveCount(0);
    await expect(page.locator("#composer-input")).toHaveValue("失败后保留草稿");
    await expect(page.locator(".chat-message.user")).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally {
    releaseSubmission?.();
    gates.forEach((gate) => gate.release());
    await dashboard?.stop();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});
