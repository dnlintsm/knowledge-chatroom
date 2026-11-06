import { test, expect } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { workspaceImagePath, workspaceImages, type WorkspaceImagesOptions } from "../../src/components/workspace/markdown-images";

/** Markdown preview images that point at workspace files (src/components/workspace/markdown-images.ts). */

test("image paths are read relative to the document's folder", () => {
  expect(workspaceImagePath("notes/report.md", "plot.png")).toBe("notes/plot.png");
  expect(workspaceImagePath("notes/report.md", "./uploads/plot.png")).toBe("notes/uploads/plot.png");
  expect(workspaceImagePath("notes/deep/report.md", "../uploads/plot.png")).toBe("notes/uploads/plot.png");
  expect(workspaceImagePath("notes/report.md", "../uploads/./a/../plot.png")).toBe("uploads/plot.png");
  expect(workspaceImagePath("readme.md", "img/logo.png")).toBe("img/logo.png");
});

test("encoded names, queries and fragments resolve to the file", () => {
  expect(workspaceImagePath("notes/report.md", "my%20plot.png")).toBe("notes/my plot.png");
  expect(workspaceImagePath("notes/report.md", "plot.png?raw=1#top")).toBe("notes/plot.png");
});

test("URLs, absolute paths and paths leaving the workspace are not workspace images", () => {
  for (const src of [
    "https://example.com/a.png",
    "data:image/png;base64,AAAA",
    "blob:https://app/1",
    "//cdn.example.com/a.png",
    "/api/files/a.png",
    "#anchor",
    "../../outside.png",
    "..",
    "./",
    "bad%E0%A4%A.png",
    "",
    undefined,
  ]) {
    expect(workspaceImagePath("notes/report.md", src), String(src)).toBeNull();
  }
});

test("the preview shows workspace images from their file URLs, before harden runs", () => {
  const { harden, ...beforeHarden } = defaultRehypePlugins;
  const files: Record<string, string> = {
    "notes/uploads/plot.png": "/api/files/notes/uploads/plot.png?v=abc",
    "notes/chart.png": "data:image/png;base64,iVBORw0KGgo=",
  };
  const withImages: [typeof workspaceImages, WorkspaceImagesOptions] = [
    workspaceImages,
    {
      key: "notes/report.md",
      url: (src) => {
        const path = workspaceImagePath("notes/report.md", src);
        return (path && files[path]) || null;
      },
    },
  ];
  const plugins = [...Object.values(beforeHarden), withImages, harden];
  const html = renderToStaticMarkup(
    createElement(
      Streamdown,
      { mode: "static", rehypePlugins: plugins },
      "![plot](./uploads/plot.png) ![chart](chart.png) ![web](https://example.com/w.png) ![gone](missing.png)",
    ),
  );
  expect(html).toContain('src="/api/files/notes/uploads/plot.png?v=abc"');
  expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  expect(html).toContain('src="https://example.com/w.png"');
  // Not in the workspace: left to harden, as before.
  expect(html).not.toContain("missing.png\"");
});
