import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import template from "../config/default.example.json";
import * as config from "../src/backend/config";
import * as har from "../src/backend/har-parser";
import { offlinePlugin } from "../src/backend/offline-routes";

const fetchMock = mock<typeof fetch>();
const createApp = () => new Elysia().use(offlinePlugin).get("/local", () => "local route");

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => new Response('{"success":true}', {
    headers: { "content-type": "application/json" }
  }));
  spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  spyOn(config, "loadConfig").mockResolvedValue(structuredClone(template));
  spyOn(har, "getMockResponse").mockReturnValue(null);
});

afterEach(() => {
  mock.restore();
});

describe("Rain Classroom API interception", () => {
  test("proxies an unregistered chapter route with its full query and upstream response", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"data":{"course_chapter":[]}}', {
      status: 206,
      headers: { "content-type": "application/json", "x-upstream": "preserved" }
    }));
    const path = "/mooc-api/v1/lms/learn/course/chapter?cid=123&sign=a%2Bb&term=latest&classroom_id=123";
    const response = await createApp().handle(new Request(`http://localhost${path}`));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://www.yuketang.cn${path}`);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-upstream")).toBe("preserved");
    expect(await response.json()).toEqual({ data: { course_chapter: [] } });
  });

  test("forwards the raw POST body before Elysia parses it", async () => {
    const body = ' { "message": "原始内容", "values": [1, 2] }\n';
    const response = await createApp().handle(new Request("http://localhost/mooc-api/save", {
      method: "POST", headers: { "content-type": "application/json" }, body
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const options = fetchMock.mock.calls[0][1];
    expect(options?.method).toBe("POST");
    expect(new Headers(options?.headers).get("content-type")).toBe("application/json");
    expect(new TextDecoder().decode(options?.body as ArrayBuffer)).toBe(body);
  });

  test("serves offline hits and misses while leaving unrelated routes unchanged", async () => {
    spyOn(config, "loadConfig").mockResolvedValue({ ...structuredClone(template), offlineMode: true });
    spyOn(har, "getMockResponse").mockReturnValueOnce({
      status: 200, mimeType: "application/json", text: '{"data":{"course_chapter":[]}}'
    });
    const app = createApp();
    const hit = await app.handle(new Request("http://localhost/mooc-api/v1/lms/learn/course/chapter?cid=123"));
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({ data: { course_chapter: [] } });

    const miss = await app.handle(new Request("http://localhost/mooc-api/missing"));
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ error: "API endpoint mock cache miss in local HAR files" });
    expect((await app.handle(new Request("http://localhost/unrelated"))).status).toBe(404);
    const local = await app.handle(new Request("http://localhost/local"));
    expect(local.status).toBe(200);
    expect(await local.text()).toBe("local route");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
