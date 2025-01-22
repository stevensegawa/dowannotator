/*
 * Copyright 2014 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// PLEASE NOTE: This code is intended for development purposes only and
//              should NOT be used in production environments.

import fs from "fs";
import fsPromises from "fs/promises";
import http from "http";
import path from "path";
import { pathToFileURL } from "url";
import { createClient } from '@supabase/supabase-js';

const MIME_TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".xhtml": "application/xhtml+xml",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".log": "text/plain",
  ".bcmap": "application/octet-stream",
  ".ftl": "text/plain",
  ".wasm": "application/wasm",
};
const DEFAULT_MIME_TYPE = "application/octet-stream";

class WebServer {
  constructor({ root, host, port, cacheExpirationTime }) {
    const cwdURL = pathToFileURL(process.cwd()) + "/";
    this.rootURL = new URL(`${root || "."}/`, cwdURL);
    this.host = host || "localhost";
    this.port = port || 0;
    this.server = null;
    this.verbose = false;
    this.cacheExpirationTime = cacheExpirationTime || 0;
    this.disableRangeRequests = false;
    this.hooks = {
      GET: [crossOriginHandler, redirectHandler],
      POST: [],
    };

    // Add Supabase configuration
    const supabaseUrl = 'https://kazsquqfjxrkpzelptxv.supabase.co';
    const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthenNxdXFmanhya3B6ZWxwdHh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzcxMDA5MTgsImV4cCI6MjA1MjY3NjkxOH0.s1aKodToiu4SBPjM6fWI1SEEpHvc7eOY8addbJNm-Yo';
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  start(callback) {
    this.#ensureNonZeroPort();
    this.server = http.createServer(this.#handler.bind(this));
    this.server.listen(this.port, this.host, callback);
    console.log(`Server running at http://${this.host}:${this.port}/`);
  }

  stop(callback) {
    this.server.close(callback);
    this.server = null;
  }

  #ensureNonZeroPort() {
    if (!this.port) {
      // If port is 0, a random port will be chosen instead. Do not set a host
      // name to make sure that the port is synchronously set by `.listen()`.
      const server = http.createServer().listen(0);
      const address = server.address();
      // `.address().port` being available synchronously is merely an
      // implementation detail, so we are defensive here and fall back to a
      // fixed port when the address is not available yet.
      this.port = address ? address.port : 8000;
      server.close();
    }
  }

  async #handler(request, response) {
    // URLs are normalized and automatically disallow directory traversal
    // attacks. For example, http://HOST:PORT/../../../../../../../etc/passwd
    // is equivalent to http://HOST:PORT/etc/passwd.
    const url = new URL(`http://${this.host}:${this.port}${request.url}`);

    // Handle file uploads and deletes
    if (url.pathname === "/upload") {
      this.#handleUpload(request, response);
      return;
    } else if (url.pathname === "/delete") {
      this.#handleDelete(request, response);
      return;
    }

    // Validate the request method and execute method hooks.
    const methodHooks = this.hooks[request.method];
    if (!methodHooks) {
      response.writeHead(405);
      response.end("Unsupported request method", "utf8");
      return;
    }
    const handled = methodHooks.some(hook => hook(url, request, response));
    if (handled) {
      return;
    }

    // Check the request and serve the file/folder contents.
    if (url.pathname === "/favicon.ico") {
      url.pathname = "/test/resources/favicon.ico";
    }
    await this.#checkRequest(request, response, url);
  }

  async #checkRequest(request, response, url) {
    // Special handling for /web/pdfs/ directory
    if (url.pathname === "/web/pdfs/" || url.pathname === "/web/pdfs") {
      if (!url.pathname.endsWith("/")) {
        response.setHeader("Location", `/web/pdfs/${url.search}`);
        response.writeHead(301);
        response.end("Redirected", "utf8");
        return;
      }
      await this.#serveDirectoryIndex(response, url);
      return;
    }

    // Handle file uploads and deletes
    if (url.pathname === "/upload") {
      await this.#handleUpload(request, response);
      return;
    } else if (url.pathname === "/delete") {
      await this.#handleDelete(request, response);
      return;
    }

    const localURL = new URL(`.${url.pathname}`, this.rootURL);

    // Check if the file/folder exists.
    try {
      await fsPromises.realpath(localURL);
    } catch (e) {
      if (e instanceof URIError) {
        // If the URI cannot be decoded, a `URIError` is thrown. This happens
        // for malformed URIs such as `http://localhost:8888/%s%s` and should be
        // handled as a bad request.
        response.writeHead(400);
        response.end("Bad request", "utf8");
        return;
      }

      response.writeHead(404);
      response.end();
      if (this.verbose) {
        console.error(`${url}: not found`);
      }
      return;
    }

    // Get the properties of the file/folder.
    let stats;
    try {
      stats = await fsPromises.stat(localURL);
    } catch {
      response.writeHead(500);
      response.end();
      return;
    }
    const fileSize = stats.size;
    const isDir = stats.isDirectory();

    // If a folder is requested, serve the directory listing.
    if (isDir && !/\/$/.test(url.pathname)) {
      response.setHeader("Location", `${url.pathname}/${url.search}`);
      response.writeHead(301);
      response.end("Redirected", "utf8");
      return;
    }
    if (isDir) {
      await this.#serveDirectoryIndex(response, url, localURL);
      return;
    }

    // If a file is requested with range requests, serve it accordingly.
    const { range } = request.headers;
    if (range && !this.disableRangeRequests) {
      const rangesMatches = /^bytes=(\d+)-(\d+)?/.exec(range);
      if (!rangesMatches) {
        response.writeHead(501);
        response.end("Bad range", "utf8");
        if (this.verbose) {
          console.error(`${url}: bad range: ${range}`);
        }
        return;
      }

      const start = +rangesMatches[1];
      const end = +rangesMatches[2];
      if (this.verbose) {
        console.log(`${url}: range ${start}-${end}`);
      }
      this.#serveFileRange(
        response,
        localURL,
        url.searchParams,
        fileSize,
        start,
        isNaN(end) ? fileSize : end + 1
      );
      return;
    }

    // Otherwise, serve the file normally.
    if (this.verbose) {
      console.log(url);
    }
    this.#serveFile(response, localURL, fileSize);
  }

  async #serveDirectoryIndex(response, url) {
    response.setHeader("Content-Type", "text/html");
    response.writeHead(200);

    let files = [];
    try {
      // List files from Supabase storage
      const { data, error } = await this.supabase.storage
        .from('pdfs')
        .list('', {
          limit: 100,
          offset: 0,
          sortBy: { column: 'name', order: 'asc' }
        });

      if (error) {
        throw error;
      }

      files = data || [];
    } catch (error) {
      console.error("Error listing files:", error);
    }

    response.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Defenders of Wildlife Document Annotator</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background-color: #f0f2f5;
            color: #333;
            margin: 0;
            padding: 20px;
          }
          h1 {
            color: #0056b3;
          }
          .upload-form {
            margin: 20px 0;
            padding: 15px;
            background: #fff;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          }
          .upload-form input[type="file"] {
            margin-right: 10px;
          }
          .file-list {
            margin: 20px 0;
          }
          .file-item {
            display: flex;
            align-items: center;
            margin: 10px 0;
            padding: 10px;
            background: #fff;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          }
          .file-item a {
            color: #0056b3;
            text-decoration: none;
            font-weight: bold;
            flex-grow: 1;
          }
          .file-item a:hover {
            text-decoration: underline;
          }
          .delete-button {
            margin-left: auto;
            background-color: #0056b3;
            color: white;
            border: none;
            padding: 8px 12px;
            border-radius: 4px;
            cursor: pointer;
          }
          .delete-button:hover {
            background-color: #004494;
          }
          #uploadMessage {
            color: red;
            margin-top: 10px;
          }
        </style>
      </head>
      <body>
      <h1>Defenders of Wildlife Document Annotator</h1>`);

    // Add upload form
    response.write(`
      <div class="upload-form">
        <form id="uploadForm" action="/upload" method="post" enctype="multipart/form-data">
          <input type="file" name="pdf" accept=".pdf" required>
          <input type="submit" value="Upload PDF">
        </form>
        <div id="uploadMessage" style="color: red; margin-top: 10px;"></div>
      </div>
      <script>
        document.getElementById('uploadForm').onsubmit = async function(event) {
          event.preventDefault();
          const formData = new FormData(this);
          const response = await fetch('/upload', {
            method: 'POST',
            body: formData
          });
          const result = await response.json();
          const messageDiv = document.getElementById('uploadMessage');
          if (result.error) {
            messageDiv.textContent = result.error;
          } else {
            messageDiv.textContent = '';
            location.reload();
          }
        };
      </script>
      <div class="file-list">
    `);

    const escapeHTML = untrusted =>
      untrusted
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

    // List files from Supabase
    for (const file of files) {
      const filename = file.name;
      // Get public URL for the file
      const { data } = this.supabase.storage
        .from('pdfs')
        .getPublicUrl(filename);

      const publicUrl = new URL(data.publicUrl);
      // Add cache busting parameter using the file's last modified time
      publicUrl.searchParams.set('v', file.updated_at || Date.now());
      
      // Properly encode the URL and add necessary parameters
      const viewerUrl = `/web/viewer.html?file=${encodeURIComponent(publicUrl.toString())}&disableRange=true`;

      response.write(
        `<div class="file-item">
          <a href="${viewerUrl}" target="_blank">${escapeHTML(filename)}</a>
          <button onclick="deleteFile('${escapeHTML(filename)}')" class="delete-button">
            Delete
          </button>
        </div>`
      );
    }

    response.write('</div>');

    if (files.length === 0) {
      response.write("<p>No files found</p>");
    }

    // Add delete functionality script
    response.write(`
      <script>
        async function deleteFile(filename) {
          if (!confirm('Delete ' + filename + '?')) {
            return;
          }
          
          try {
            const response = await fetch('/delete', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({ filename })
            });
            
            if (!response.ok) {
              const data = await response.json();
              throw new Error(data.error || 'Delete failed');
            }
            
            location.reload();
          } catch (error) {
            alert(error.message);
          }
        }
      </script>
    `);

    response.end("</body></html>");
  }

  #serveFile(response, fileURL, fileSize) {
    const stream = fs.createReadStream(fileURL, { flags: "rs" });
    stream.on("error", error => {
      response.writeHead(500);
      response.end();
    });

    if (!this.disableRangeRequests) {
      response.setHeader("Accept-Ranges", "bytes");
    }
    response.setHeader("Content-Type", this.#getContentType(fileURL));
    response.setHeader("Content-Length", fileSize);
    if (this.cacheExpirationTime > 0) {
      const expireTime = new Date();
      expireTime.setSeconds(expireTime.getSeconds() + this.cacheExpirationTime);
      response.setHeader("Expires", expireTime.toUTCString());
    }
    response.writeHead(200);
    stream.pipe(response);
  }

  #serveFileRange(response, fileURL, searchParams, fileSize, start, end) {
    if (end > fileSize || start > end) {
      response.writeHead(416);
      response.end();
      return;
    }
    const stream = fs.createReadStream(fileURL, {
      flags: "rs",
      start,
      end: end - 1,
    });
    stream.on("error", error => {
      response.writeHead(500);
      response.end();
    });

    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", this.#getContentType(fileURL));
    response.setHeader("Content-Length", end - start);
    response.setHeader(
      "Content-Range",
      `bytes ${start}-${end - 1}/${fileSize}`
    );

    // Support test in `test/unit/network_spec.js`.
    switch (searchParams.get("test-network-break-ranges")) {
      case "missing":
        response.removeHeader("Content-Range");
        break;
      case "invalid":
        response.setHeader("Content-Range", "bytes abc-def/qwerty");
        break;
    }
    response.writeHead(206);
    stream.pipe(response);
  }

  #getContentType(fileURL) {
    const extension = path.extname(fileURL.pathname).toLowerCase();
    return MIME_TYPES[extension] || DEFAULT_MIME_TYPE;
  }

  async #handleUpload(request, response) {
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }

    const contentType = request.headers["content-type"];
    const boundary = contentType.split("; boundary=")[1];

    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    
    request.on("end", async () => {
      try {
        const buffer = Buffer.concat(chunks);
        
        // Split the multipart data using the boundary
        const parts = buffer.toString().split(`--${boundary}`);
        
        // Find the PDF file part
        const pdfPart = parts.find(part => 
          part.includes('Content-Type: application/pdf') || 
          part.includes('name="pdf"')
        );

        if (!pdfPart) {
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: "No PDF file found in upload" }));
          return;
        }

        // Get the filename
        const filenameMatch = pdfPart.match(/filename="([^"]+)"/);
        const filename = filenameMatch ? filenameMatch[1] : "uploaded.pdf";

        // Check if file already exists
        const { data: existingFiles, error: listError } = await this.supabase.storage
          .from('pdfs')
          .list('', {
            limit: 1,
            search: filename
          });

        if (listError) {
          throw listError;
        }

        if (existingFiles.length > 0) {
          response.writeHead(409, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: "A file with the same name already exists." }));
          return;
        }

        // Extract the raw binary data
        const fileContent = buffer.slice(
          buffer.indexOf(Buffer.from([13, 10, 13, 10])) + 4,
          buffer.lastIndexOf(Buffer.from(`--${boundary}--`)) - 2
        );

        // Upload to Supabase storage
        const { data, error } = await this.supabase.storage
          .from('pdfs')
          .upload(filename, fileContent, {
            contentType: 'application/pdf',
            upsert: true
          });

        if (error) {
          throw error;
        }

        // Send success response
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true }));

      } catch (error) {
        console.error("Upload error:", error);
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: "Upload failed: " + error.message }));
      }
    });
  }

  async #handleDelete(request, response) {
    if (request.method !== "POST") {
      response.writeHead(405, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    
    request.on("end", async () => {
      try {
        const data = Buffer.concat(chunks).toString();
        const params = new URLSearchParams(data);
        const filename = params.get("filename");

        if (!filename) {
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: "No filename provided" }));
          return;
        }

        // Delete from Supabase storage
        const { error } = await this.supabase.storage
          .from('pdfs')
          .remove([filename]);

        if (error) {
          throw error;
        }

        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true }));

      } catch (error) {
        console.error("Delete error:", error);
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: "Delete failed: " + error.message }));
      }
    });
  }
}

// This supports the "Cross-origin" test in test/unit/api_spec.js
// and "Redirects" in test/unit/network_spec.js and
// test/unit/fetch_stream_spec.js via test/unit/common_pdfstream_tests.js.
// It is here instead of test.mjs so that when the test will still complete as
// expected if the user does "gulp server" and then visits
// http://localhost:8888/test/unit/unit_test.html?spec=Cross-origin
function crossOriginHandler(url, request, response) {
  if (url.pathname === "/test/pdfs/basicapi.pdf") {
    if (!url.searchParams.has("cors") || !request.headers.origin) {
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
    if (url.searchParams.get("cors") === "withCredentials") {
      response.setHeader("Access-Control-Allow-Credentials", "true");
    } // withoutCredentials does not include Access-Control-Allow-Credentials.
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Accept-Ranges,Content-Range"
    );
    response.setHeader("Vary", "Origin");
  }
}

// This supports the "Redirects" test in test/unit/network_spec.js and
// test/unit/fetch_stream_spec.js via test/unit/common_pdfstream_tests.js.
// It is here instead of test.mjs so that when the test will still complete as
// expected if the user does "gulp server" and then visits
// http://localhost:8888/test/unit/unit_test.html?spec=Redirects
function redirectHandler(url, request, response) {
  const redirectToHost = url.searchParams.get("redirectToHost");
  if (redirectToHost) {
    // Chrome may serve byte range requests directly from the cache, potentially
    // from a full request or a different range, without involving the server.
    // To prevent this from happening, make sure that the response is never
    // cached, so that Range requests are never served from the browser cache.
    response.setHeader("Cache-Control", "no-store,max-age=0");

    if (url.searchParams.get("redirectIfRange") && !request.headers.range) {
      return false;
    }
    try {
      const newURL = new URL(url);
      newURL.hostname = redirectToHost;
      // Delete test-only query parameters to avoid infinite redirects.
      newURL.searchParams.delete("redirectToHost");
      newURL.searchParams.delete("redirectIfRange");
      if (newURL.hostname !== redirectToHost) {
        throw new Error(`Invalid hostname: ${redirectToHost}`);
      }
      response.setHeader("Location", newURL.href);
    } catch {
      response.writeHead(500);
      response.end();
      return true;
    }
    response.writeHead(302);
    response.end();
    return true;
  }
  return false;
}

export { WebServer };
