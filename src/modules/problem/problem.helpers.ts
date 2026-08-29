import * as cheerio from "cheerio";
import { Element, DataNode, Node } from "domhandler";
import type { TParsedProblem, TProblemIdentifier } from "./problem.service.js";
import env from "@/config/env.js";
import { utils } from "@/utils/index.js";

export const getProblemUrl = ({ contestId, problemIndex }: TProblemIdentifier) =>
  `${env.CODEFORCES_BASE_URL}/problemset/problem/${contestId}/${problemIndex}`;

function extractTextAndImages(el: Element): string {
  const parts: string[] = [];

  const walk = (node: Node) => {
    if (node.type === "text") {
      const text = (node as DataNode).data.trim();
      if (text) parts.push(text);
      return;
    }

    if (node.type === "tag") {
      const tag = node as Element;

      if (tag.name === "img" && tag.attribs.src) {
        parts.push(tag.attribs.src);
      }

      tag.children.forEach(walk);
    }
  };

  walk(el);

  return parts.join(" ");
}

function parseLimit(text: string) {
  const parts = text.trim().split(/\s+/);

  return {
    value: Number(parts[0]),
    unit: parts.slice(1).join(" "),
  };
}

export function parseProblemFromHtml(html: string): TParsedProblem {
  const $ = cheerio.load(html);

  const { value: timeLimitValue, unit: timeLimitUnit } = parseLimit(
    $(".problem-statement .header .time-limit").contents().last().text().trim(),
  );

  const { value: memoryLimitValue, unit: memoryLimitUnit } = parseLimit(
    $(".problem-statement .header .memory-limit").contents().last().text().trim(),
  );

  const editorialHref = $("#sidebar ul li a")
    .toArray()
    .find((el) => {
      const title = $(el).attr("title") ?? "";
      const href = $(el).attr("href") ?? "";

      return (title.includes("Editorial") || title.includes("Tutorial")) && href.startsWith("/blog/entry/");
    })?.attribs.href;

  const editorialUrl = editorialHref ? new URL(editorialHref, env.CODEFORCES_BASE_URL).href : "";

  return {
    title: $(".problem-statement .header .title").text().trim(),
    timeLimitValue,
    timeLimitUnit,
    memoryLimitValue,
    memoryLimitUnit,
    problemStatement: $(".problem-statement")
      .children("div")
      .not(".header")
      .first()
      .map((_, el) => extractTextAndImages(el))
      .get()
      .join(" "),
    inputSpecification: $(".problem-statement .input-specification p")
      .map((_, el) => extractTextAndImages(el))
      .get()
      .join(" "),
    outputSpecification: $(".problem-statement .output-specification p")
      .map((_, el) => extractTextAndImages(el))
      .get()
      .join(" "),
    inputTestCase: $(".problem-statement .sample-test .input pre")
      .map((_, el) =>
        $(el)
          .contents()
          .map((_, node) => $(node).text().trim())
          .get()
          .filter(Boolean)
          .join("\n"),
      )
      .get()
      .join("\n"),
    outputTestCase: $(".problem-statement .sample-test .output pre")
      .map((_, el) =>
        $(el)
          .contents()
          .map((_, node) => $(node).text().trim())
          .get()
          .filter(Boolean)
          .join("\n"),
      )
      .get()
      .join("\n"),
    rating: utils.stringToNumber($("#sidebar .tag-box").last().text()),
    tags: $("#sidebar .tag-box")
      .slice(0, -1)
      .map((_, el) => $(el).text().trim())
      .get(),
    editorialUrl,
    note: $(".problem-statement .note")
      .map((_, el) => extractTextAndImages(el))
      .get()
      .join(" "),
  };
}

export function parseSolutionFromHtml(html: string): string[][] {
  const $ = cheerio.load(html);

  const solutions: string[][] = [];

  $(".content .ttypography > .spoiler").each((_, spoiler) => {
    const codes = $(spoiler)
      .children(".spoiler-content")
      .find("pre code")
      .map((_, code) => $(code).text().trim())
      .get();

    if (codes.length) {
      solutions.push(codes);
    }
  });

  return solutions;
}
