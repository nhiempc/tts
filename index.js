// server.js
import express from "express";
import fetch from "node-fetch"; // Node 18+ có fetch sẵn; nếu lỗi: npm i node-fetch
import path from "path";
import archiver from "archiver";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Đọc form-urlencoded + JSON
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));

// Phục vụ static UI ở thư mục /public
app.use(express.static(path.join(__dirname, "public")));

// Hàm tiện ích: gọi fetch tối đa maxRetries lần
async function fetchWithRetry(url, options, maxRetries = 3, delayMs = 500) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }
      return resp; // thành công thì trả về
    } catch (err) {
      lastErr = err;
      console.warn(`Fetch attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxRetries) {
        // chờ một lúc rồi thử lại
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  // Nếu hết số lần retry vẫn lỗi, ném error cuối cùng
  throw lastErr;
}

/**
 * Proxy endpoint:
 * - Trình duyệt POST tới /api/tts (same-origin với server Node)
 * - Node forward tới https://gowithnd.com/user/ai/gts/generate
 * - Cookie forward từ header 'x-forward-cookie'
 */
app.post("/api/tts", async (req, res) => {
  try {
    const {
      _token,
      name,
      content,
      voice_language,
      voice_gender,
      voices,
      audio_format,
      speed,
    } = req.body;

    const forwardCookie = req.get("x-forward-cookie") || "";

    const form = new URLSearchParams({
      _token: _token ?? "",
      name: String(name ?? ""),
      content: content ?? "",
      voice_language: voice_language ?? "en-us",
      voice_gender: voice_gender ?? "male",
      voices: voices ?? "am_puck",
      audio_format: audio_format ?? "mp3",
      speed: String(speed ?? "1.0"),
    });

    const resp = await fetchWithRetry(
      "https://gowithnd.com/user/ai/gts/generate",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          "accept-language": "vi,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7,zh;q=0.6",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-csrf-token": _token || "",
          "x-requested-with": "XMLHttpRequest",
          cookie: forwardCookie, // <— Node có thể set Cookie header (giống Postman)
          origin: "https://gowithnd.com", // không bắt buộc, thêm cho “giống curl”
          referer: "https://gowithnd.com/user/ai/gts/new",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        body: form.toString(),
      },
      3,
      500
    );

    const text = await resp.text();
    res.status(resp.status).send(text);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: String(e) });
  }
});

// Tải file qua proxy, kèm cookie và ép Content-Disposition để tải ngay
app.get("/api/download", async (req, res) => {
  try {
    const { path: systemPath, name } = req.query;
    if (!systemPath) return res.status(400).send("Missing 'path'");

    // cookie chuỗi bạn dán trong UI, ví dụ "XSRF-TOKEN=...; go_with_nd_session=..."
    let forwardCookie = req.get("x-forward-cookie") || "";

    // LƯU Ý: nếu bạn copy từ curl/Postman, cookie value có thể dạng URL-encoded (%3D...).
    // Thông thường server vẫn accept giá trị này.
    // Nếu vẫn 404, bạn có thể thử giải mã:
    // forwardCookie = decodeURIComponent(forwardCookie);

    const fileUrl = `https://gowithnd.com/${String(systemPath).replace(
      /^\/+/,
      ""
    )}`;
    // Theo dõi redirect thủ công để phát hiện /login
    const first = await fetch(fileUrl, {
      redirect: "manual",
      headers: {
        cookie: forwardCookie,
        "user-agent": "Mozilla/5.0",
        referer: "https://gowithnd.com/",
      },
    });

    // Nếu redirect (302/303/307/308)
    if ([301, 302, 303, 307, 308].includes(first.status)) {
      const loc = first.headers.get("location") || "";
      // Nếu bị chuyển tới màn login => cookie không hợp lệ/hết hạn
      if (/login/i.test(loc)) {
        return res
          .status(401)
          .send(
            `Redirected to login (${loc}). Cookie phiên có thể hết hạn hoặc sai.`
          );
      }
      // Theo tiếp redirect 1 lần nữa
      const second = await fetch(new URL(loc, fileUrl).toString(), {
        headers: {
          cookie: forwardCookie,
          "user-agent": "Mozilla/5.0",
          referer: "https://gowithnd.com/",
        },
      });
      if (!second.ok) {
        const txt = await second.text().catch(() => "");
        return res
          .status(second.status)
          .send(
            `Upstream error after redirect (${
              second.status
            }). Body: ${txt.slice(0, 300)}`
          );
      }
      const ct = second.headers.get("content-type") || "audio/mpeg";
      const buf = Buffer.from(await second.arrayBuffer());
      const safeName = (name || "audio.mp3").replace(/[^a-zA-Z0-9_.-]/g, "_");
      res.setHeader("Content-Type", ct);
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeName}"`
      );
      return res.status(200).send(buf);
    }

    // Không redirect, kiểm tra trạng thái
    if (!first.ok) {
      const txt = await first.text().catch(() => "");
      return res
        .status(first.status)
        .send(
          `Upstream error (${first.status}). URL: ${fileUrl}\nBody: ${txt.slice(
            0,
            300
          )}`
        );
    }

    // OK: trả dữ liệu
    const ct = first.headers.get("content-type") || "audio/mpeg";
    const buf = Buffer.from(await first.arrayBuffer());
    const safeName = (name || "audio.mp3").replace(/[^a-zA-Z0-9_.-]/g, "_");
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    return res.status(200).send(buf);
  } catch (e) {
    console.error(e);
    return res.status(500).send(String(e));
  }
});

app.post("/api/download-zip", async (req, res) => {
  try {
    const forwardCookie = req.get("x-forward-cookie") || "";
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).send("No items");

    // Thiết lập trả về ZIP dạng stream
    res.setHeader("Content-Type", "application/zip");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tts_batch_${stamp}.zip"`
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      throw err;
    });
    archive.pipe(res);

    for (const it of items) {
      const systemPath = String(it.path || "").replace(/^\/+/, "");
      const safeName = String(it.name || "audio.mp3").replace(
        /[^a-zA-Z0-9_.-]/g,
        "_"
      );
      const fileUrl = `https://gowithnd.com/${systemPath}`;

      // Tải từng file bằng cookie (giống /api/download)
      const r = await fetch(fileUrl, {
        headers: {
          cookie: forwardCookie,
          "user-agent": "Mozilla/5.0",
          referer: "https://gowithnd.com/",
        },
        redirect: "follow",
      });

      if (!r.ok) {
        // Nếu lỗi, thêm file .txt mô tả lỗi vào zip để bạn biết mục nào fail
        const errTxt = `Failed: ${systemPath}\nHTTP ${r.status}\n`;
        archive.append(errTxt, { name: `${safeName}.ERROR.txt` });
        continue;
      }

      const buf = Buffer.from(await r.arrayBuffer());
      archive.append(buf, { name: safeName });
    }

    await archive.finalize(); // kết thúc và flush về client
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).send(String(e));
    else res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server đang chạy: http://localhost:${PORT}`)
);
