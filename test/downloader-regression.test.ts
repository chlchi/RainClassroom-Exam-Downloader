import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, relative } from "path";
import template from "../config/default.example.json";
import * as config from "../src/backend/config";
import * as har from "../src/backend/har-parser";
import { downloadLesson, progressClients } from "../src/backend/downloader";

const lessonId = "1234567890123456789";
const leafId = "101";
const title = "Slides-0102";
let outputRoot: string;
let activeConfig: config.Config;
let requests: string[];
let missingLeaf: boolean;
let emptyTimeline: boolean;
let statuses: string[];
let client: { send: (payload: string) => void };

function apiResponse(url: string): string {
  requests.push(url);
  const path = new URL(url).pathname;
  if (path.includes("/leaf_info/")) return missingLeaf ? '{"success":false}' :
    `{"success":true,"data":{"id":101,"leaf_type":8,"title":"Renamed lecture","content_info":{"leaf_type_id":${lessonId}}}}`;
  if (path.includes("/logs/learn/")) return `{"data":{"activities":[{"type":14,"title":"${title}","courseware_id":${lessonId}}]}}`;
  if (path.endsWith("/lesson-info")) return '{"data":{}}';
  if (path.endsWith("/review")) return JSON.stringify({ data: { timelineList: emptyTimeline ? [] : [
    { type: "slide", presentationId: "pres", index: 1, cover: "https://example.test/slide.jpg", hasProblem: true }
  ] } });
  if (path === "/exam_room/cover") return '{"data":{"title":"Homework","problem_count":1}}';
  if (path === "/exam_room/show_paper") return '{"data":{"problems":[{"ProblemID":1,"Body":"Example question"}]}}';
  if (path === "/exam_room/problem_results") return '{"data":{"problem_results":[]}}';
  throw new Error(`Unexpected API URL: ${url}`);
}

beforeEach(async () => {
  outputRoot = await mkdtemp(join(tmpdir(), "rainclassroom-downloader-"));
  activeConfig = { ...structuredClone(template), downloadDir: outputRoot, offlineMode: true };
  requests = [];
  statuses = [];
  missingLeaf = false;
  emptyTimeline = false;
  client = { send: payload => { statuses.push(JSON.parse(payload).status); } };
  progressClients.add(client);
  spyOn(config, "loadConfig").mockImplementation(async () => activeConfig);
  spyOn(har, "getMockResponse").mockImplementation((_method, url) => ({
    status: 200, mimeType: "application/json", text: apiResponse(url)
  }));
  spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://example.test/slide.jpg") return new Response(new Uint8Array([255, 216, 255, 217]));
    return new Response(apiResponse(url), { headers: { "content-type": "application/json" } });
  });
});

afterEach(async () => {
  progressClients.delete(client);
  mock.restore();
  await rm(outputRoot, { recursive: true, force: true });
});

describe("Downloader regressions", () => {
  for (const kind of ["absolute", "relative"] as const) {
    test(`saves slides, problems and homework below the ${kind} output root`, async () => {
      activeConfig.downloadDir = kind === "absolute" ? outputRoot : relative(process.cwd(), outputRoot);
      await downloadLesson("123", leafId, "Course", 1, title, 8);
      const slide = await readFile(join(outputRoot, "Course", "01_Course_20260102", "001.jpg"));
      const problem = await readFile(join(outputRoot, "Course", "problem", "01_01.jpg"));
      expect(slide.length).toBeGreaterThan(0);
      expect(problem.equals(slide)).toBe(true);
      await downloadLesson("123", "homework", "Course", 2, "Homework", 9);
      const markdown = await readFile(join(outputRoot, "Course", "02_Homework", "Homework.md"), "utf-8");
      expect(markdown).toContain("# 作业详情: Homework");
      expect(markdown).toContain("Example question");
      expect(statuses.at(-1)).toBe("completed");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  }

  test("uses leaf details for renamed lectures and preserves online lesson IDs and platform headers", async () => {
    activeConfig.offlineMode = false;
    activeConfig.cookies.university_id = "42";
    // The frontend sends leaf IDs as JSON numbers despite the string annotation.
    await downloadLesson("123", Number(leafId) as unknown as string, "Course", 1, title, 8);
    expect(requests.find(url => new URL(url).pathname.endsWith("/review"))).toBe(
      `https://www.yuketang.cn/api/v3/classroom-report/student/review?lesson_id=${lessonId}`
    );
    expect(requests.some(url => url.includes("/logs/learn/"))).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `https://www.yuketang.cn/mooc-api/v1/lms/learn/leaf_info/123/${leafId}/?classroom_id=123`,
      expect.objectContaining({ headers: expect.objectContaining({
        "xtbz": "ykt", "university-id": "42", "platform-id": "3", "x-client": "web", "terminal-type": "web"
      }) })
    );
    expect((await readFile(join(outputRoot, "Course", "01_Course_20260102", "001.jpg"))).length).toBeGreaterThan(0);
    expect(statuses.at(-1)).toBe("completed");
  });

  for (const fallback of [false, true]) {
    test(`preserves HAR lesson IDs from ${fallback ? "legacy title matching" : "leaf details"}`, async () => {
      missingLeaf = fallback;
      await downloadLesson("123", leafId, "Course", 1, title, 8);
      expect(requests.find(url => new URL(url).pathname.endsWith("/review"))).toContain(`lesson_id=${lessonId}`);
      expect(requests.some(url => url.includes("/logs/learn/"))).toBe(fallback);
      expect((await readFile(join(outputRoot, "Course", "01_Course_20260102", "001.jpg"))).length).toBeGreaterThan(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  }

  test("rejects an empty timeline without reporting a completed download", async () => {
    emptyTimeline = true;
    await expect(downloadLesson("123", leafId, "Course", 1, title, 8)).rejects.toThrow("no downloadable slides");
    expect(statuses).toEqual(["pending", "failed"]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
