import { Elysia } from "elysia";
import { getMockResponse, getAvailableHarCourses } from "./har-parser";
import { loadConfig, updateConfig } from "./config";

/**
 * Elysia plugin managing the offline status toggle and intercepting
 * Rain Classroom API routes when operating in offline mode.
 */
export const offlinePlugin = new Elysia()
  // 1. Get available mock or online courses list
  .get("/api/offline/courses", async () => {
    console.log("[Server] GET /api/offline/courses request received");
    const config = await loadConfig();
    console.log(`[Server] config loaded: offlineMode=${config.offlineMode}, authenticated=${!!config.cookies.sessionid}`);
    if (config.offlineMode) {
      const courses = getAvailableHarCourses(config.showArchived);
      console.log(`[Offline] Returning ${courses.length} courses from HAR cache (showArchived: ${config.showArchived})`);
      return courses;
    } else {
      // ONLINE MODE: Fetch real courses list and resolve signs
      try {
        console.log("[Online] Fetching course list from YuKeTang...");
        const cookies = config.cookies;
        const cookieHeader = [
          `sessionid=${cookies.sessionid}`,
          `csrftoken=${cookies.csrftoken}`,
          `xtbz=${cookies.xtbz}`,
          `university_id=${cookies.university_id}`,
          `platform_id=${cookies.platform_id}`
        ];
        if (cookies._cf_bm) {
          cookieHeader.push(`_cf_bm=${cookies._cf_bm}`);
        }
        
        const yktHeaders = {
          "cookie": cookieHeader.join("; "),
          "x-csrftoken": cookies.csrftoken || "",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "referer": "https://www.yuketang.cn/",
          "xtbz": cookies.xtbz || "ykt",
          "university-id": cookies.university_id || "",
          "platform-id": cookies.platform_id || "3",
          "x-client": "web",
          "terminal-type": "web"
        };

        console.log("[Online] Sending request to YuKeTang course list API (identity=2)...");
        const resList = await fetch("https://www.yuketang.cn/v2/api/web/courses/list?identity=2", {
          headers: yktHeaders
        });
        if (!resList.ok) {
          throw new Error(`Courses list HTTP error: ${resList.status}`);
        }
        const coursesData = await resList.json();
        console.log(`[Online] Course list response errcode: ${coursesData.errcode}, errmsg: ${coursesData.errmsg}`);
        
        if (coursesData.errcode !== 0) {
          throw new Error(`YuKeTang course list returned error: ${coursesData.errmsg || "Unknown error"}`);
        }

        const list = coursesData.data?.list || [];
        console.log(`[Online] Fetched ${list.length} total courses from YuKeTang`);

        let filteredList = list;
        if (!config.showArchived) {
          filteredList = list.filter((item: any) => {
            const term = String(item.term || "");
            return term === "202502" || term === "latest";
          });
        }
        console.log(`[Online] Filtered list size: ${filteredList.length} (showArchived: ${config.showArchived})`);

        // Concurrently fetch sign details
        const courses = await Promise.all(
          filteredList.map(async (item: any) => {
            const cid = item.classroom_id;
            const courseName = item.course?.name || item.name || "未知课程";
            try {
              console.log(`[Online] Fetching classroom sign details for cid: ${cid} (${courseName})`);
              const resDetail = await fetch(`https://www.yuketang.cn/v2/api/web/classrooms/${cid}?role=5`, {
                headers: yktHeaders
              });
              if (resDetail.ok) {
                const detail = await resDetail.json();
                if (detail.errcode === 0) {
                  console.log(`[Online] Successfully resolved sign for ${cid} -> ${detail.data?.course_sign}`);
                  return {
                    id: String(cid),
                    name: courseName,
                    courseSign: detail.data?.course_sign || "",
                    term: String(item.term || "latest")
                  };
                } else {
                  console.warn(`[Online] Failed to resolve sign for ${cid}: errcode ${detail.errcode}, errmsg ${detail.errmsg}`);
                }
              } else {
                console.warn(`[Online] Classroom detail HTTP error for ${cid}: ${resDetail.status}`);
              }
            } catch (err) {
              console.error(`[Online] Failed to fetch classroom sign for ${cid}:`, err);
            }
            return {
              id: String(cid),
              name: courseName,
              courseSign: "",
              term: String(item.term || "latest")
            };
          })
        );
        console.log(`[Online] Loaded ${courses.length} courses with resolved signs`);
        return courses;
      } catch (err) {
        console.error("[Online] Error loading online courses, falling back to HAR:", err);
        return getAvailableHarCourses(config.showArchived);
      }
    }
  })

  // 2. Set offline status endpoint
  .post("/api/config/offline", async ({ body }: { body: { offlineMode: boolean } }) => {
    console.log(`[Offline] Received toggle request to: ${body.offlineMode}`);
    const updated = await updateConfig({ offlineMode: body.offlineMode });
    return { success: true, offlineMode: updated.offlineMode };
  })

  // 3. Intercept upstream APIs before routing and body parsing, including unregistered paths
  .onRequest(async ({ request, set }) => {
    const config = await loadConfig();
    const urlObj = new URL(request.url);
    const pathname = urlObj.pathname;

    // We intercept Rain Classroom API prefix patterns
    const isRainClassroomApi =
      pathname.startsWith("/v2/api/") ||
      pathname.startsWith("/mooc-api/") ||
      pathname.startsWith("/api/v3/") ||
      pathname.startsWith("/api/v2/") ||
      pathname.startsWith("/course_meta/") ||
      pathname.startsWith("/c27/");

    if (isRainClassroomApi) {
      if (!config.offlineMode) {
        // ONLINE PROXY MODE: Forward to yuketang.cn with cookies
        console.log(`[Online Proxy] Forwarding: ${request.method} ${urlObj.pathname}${urlObj.search}`);
        const cookies = config.cookies;
        const cookieHeader = [
          `sessionid=${cookies.sessionid}`,
          `csrftoken=${cookies.csrftoken}`,
          `xtbz=${cookies.xtbz}`,
          `university_id=${cookies.university_id}`,
          `platform_id=${cookies.platform_id}`
        ];
        if (cookies._cf_bm) {
          cookieHeader.push(`_cf_bm=${cookies._cf_bm}`);
        }

        const targetUrl = `https://www.yuketang.cn${pathname}${urlObj.search}`;
        const headers: Record<string, string> = {
          "cookie": cookieHeader.join("; "),
          "x-csrftoken": cookies.csrftoken || "",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "referer": "https://www.yuketang.cn/",
          "xtbz": cookies.xtbz || "ykt",
          "university-id": cookies.university_id || "",
          "platform-id": cookies.platform_id || "3",
          "x-client": "web",
          "terminal-type": "web"
        };

        const contentType = request.headers.get("content-type");
        if (contentType) {
          headers["content-type"] = contentType;
        }

        let body: any = undefined;
        if (request.method !== "GET" && request.method !== "HEAD") {
          body = await request.clone().arrayBuffer();
        }

        try {
          const res = await fetch(targetUrl, {
            method: request.method,
            headers,
            body
          });

          set.status = res.status;
          res.headers.forEach((val, key) => {
            if (key !== "content-encoding" && key !== "transfer-encoding") {
              set.headers[key] = val;
            }
          });

          return await res.arrayBuffer();
        } catch (err) {
          console.error(`[Online Proxy] Fetch failed for ${targetUrl}:`, err);
          set.status = 502;
          return { error: "Failed to proxy request to YuKeTang" };
        }
      } else {
        // OFFLINE MODE: Intercept request and serve mock data
        console.log(`[Offline] Intercepting request: ${request.method} ${urlObj.href}`);
        const mock = getMockResponse(request.method, urlObj.href);
        
        if (mock) {
          set.status = mock.status;
          set.headers["content-type"] = mock.mimeType;
          if (mock.mimeType.includes("application/json")) {
            try {
              return JSON.parse(mock.text);
            } catch {
              return mock.text;
            }
          }
          return mock.text;
        } else {
          console.warn(`[Offline] No cached entry matches request for: ${request.method} ${pathname}`);
          set.status = 404;
          set.headers["content-type"] = "application/json";
          return { error: "API endpoint mock cache miss in local HAR files" };
        }
      }
    }
  });
