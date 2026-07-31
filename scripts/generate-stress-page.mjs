#!/usr/bin/env node

import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_DEPTH = 48;
const CONTAINER_TAGS = ['article', 'div', 'aside', 'blockquote', 'section'];
const PHRASES = [
  (id) => `العنصر ${id}: نص عربي واضح مع English words لاختبار اتجاه القراءة.`,
  (id) => `Element ${id}: English starts first ثم يتبعه نص عربي مختلط.`,
  (id) => `١٢٣ — العربية أول حرف في العنصر ${id}, followed by English text.`,
  (id) => `… ${id} اَلْعَرَبِيَّةُ مع punctuation وEnglish داخل السطر نفسه.`,
];

const HELP = `Usage:
  npm run stress:page -- <elements> [--depth <levels>] [--output <file>]

Arguments:
  elements          Exact number of elements generated inside <body>
  --depth, -d       Maximum nesting depth inside <body> (default: 48)
  --output, -o      Output HTML file (default: .output/stress-page-<elements>.html)
  --help, -h        Show this help

Example:
  npm run stress:page -- 50000 --depth 48
`;

function fail(message) {
  console.error(`Error: ${message}\n\n${HELP}`);
  process.exitCode = 1;
}

function positiveSafeInteger(value, name) {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return number;
}

function optionValue(argument, name) {
  return argument.startsWith(`${name}=`) ? argument.slice(name.length + 1) : null;
}

function parseArguments(arguments_) {
  let elementCount;
  let requestedDepth = DEFAULT_DEPTH;
  let output;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === '--help' || argument === '-h') return { help: true };

    const inlineDepth = optionValue(argument, '--depth');
    if (argument === '--depth' || argument === '-d' || inlineDepth !== null) {
      const value = inlineDepth ?? arguments_[index + 1];
      if (inlineDepth === null) index += 1;
      if (!value || (inlineDepth === null && value.startsWith('-'))) {
        throw new Error('--depth requires a value.');
      }
      requestedDepth = positiveSafeInteger(value, 'depth');
      continue;
    }

    const inlineOutput = optionValue(argument, '--output');
    if (argument === '--output' || argument === '-o' || inlineOutput !== null) {
      const value = inlineOutput ?? arguments_[index + 1];
      if (inlineOutput === null) index += 1;
      if (!value || (inlineOutput === null && value.startsWith('-'))) {
        throw new Error('--output requires a file path.');
      }
      output = value;
      continue;
    }

    if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    if (elementCount !== undefined) throw new Error('Only one element count may be provided.');
    elementCount = positiveSafeInteger(argument, 'elements');
  }

  if (elementCount === undefined) throw new Error('Provide the number of elements to generate.');
  if (elementCount > 1 && requestedDepth < 2) {
    throw new Error('depth must be at least 2 when generating more than one element.');
  }

  return {
    help: false,
    elementCount,
    requestedDepth,
    output: output ?? `.output/stress-page-${elementCount}.html`,
  };
}

function escapeAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function phraseFor(id) {
  return PHRASES[(id - 1) % PHRASES.length](id);
}

function attributesFor(id, level, extra = '', includeLayout = false) {
  const classes = ['stress-node'];
  if (includeLayout && id % 5 === 0) classes.push(id % 2 === 0 ? 'layout-flex' : 'layout-grid');

  const direction = id % 17 === 0 ? ' dir="ltr"' : '';
  const alignment = id % 31 === 0 ? ' style="text-align: center"' : '';
  return ` class="${classes.join(' ')}" data-element="${id}" data-level="${level}"${direction}${alignment}${extra}`;
}

function containerStart(id, level, branch) {
  const tag = level === 2 ? 'section' : CONTAINER_TAGS[(id + level + branch) % CONTAINER_TAGS.length];
  return {
    start: `<${tag}${attributesFor(id, level, '', true)}>\n${phraseFor(id)}\n`,
    end: `</${tag}>\n`,
  };
}

function formControlMarkup(id, level, target) {
  const phrase = phraseFor(id);
  const common = attributesFor(id, level, ' data-stress-target="edge"');

  switch (target % 3) {
    case 0:
      return `<input${common} type="text" value="${escapeAttribute(phrase)}">\n`;
    case 1:
      return `<textarea${common} rows="2">${phrase}</textarea>\n`;
    default:
      return `<button${common} type="button">${phrase}</button>\n`;
  }
}

function textBranchMarkup(firstId, elementCount, level, target) {
  if (elementCount === 1 && target % 16 === 15) {
    return formControlMarkup(firstId, level, target);
  }

  const safeBlockTags = ['p', 'h2', 'address', 'div', 'blockquote'];
  const edgeCaseRoots = [
    ['pre', ''],
    ['code', ''],
    ['div', ' contenteditable="true"'],
    ['div', ' role="button" tabindex="0"'],
    ['div', ' aria-hidden="true"'],
    ['p', ' hidden'],
  ];
  const inlineTags = ['span', 'strong', 'em', 'small', 'mark', 'cite', 'q', 'bdi'];
  const edgeCase = target % 13 === 12;
  const [rootTag, rootExtra] = edgeCase
    ? edgeCaseRoots[Math.floor(target / 13) % edgeCaseRoots.length]
    : [safeBlockTags[target % safeBlockTags.length], ''];
  const targetKind = edgeCase ? 'edge' : 'safe';
  const closingTags = [rootTag];
  let markup = `<${rootTag}${attributesFor(firstId, level, `${rootExtra} data-stress-target="${targetKind}"`)}>\n${phraseFor(firstId)}\n`;

  for (let offset = 1; offset < elementCount; offset += 1) {
    const id = firstId + offset;
    const tag = inlineTags[(target + offset) % inlineTags.length];
    markup += `<${tag}${attributesFor(id, level + offset)}>\n${phraseFor(id)}\n`;
    closingTags.push(tag);
  }

  for (let index = closingTags.length - 1; index >= 0; index -= 1) {
    markup += `</${closingTags[index]}>\n`;
  }

  return markup;
}

function documentStart(elementCount, actualDepth) {
  return `<!doctype html>
<html lang="ar">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tayamun stress page — ${elementCount} elements</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; line-height: 1.55; }
    main { padding: 1rem; overflow-wrap: anywhere; }
    .stress-node { border-inline-start: 1px solid color-mix(in srgb, currentColor 22%, transparent); padding-inline-start: 3px; }
    .layout-flex { display: flex; flex-direction: column; }
    .layout-grid { display: grid; grid-template-columns: minmax(0, 1fr); }
    input, textarea, button { box-sizing: border-box; max-width: 100%; font: inherit; }
  </style>
</head>
<body>
<!-- Exactly ${elementCount} body elements; deepest element is at level ${actualDepth}. -->
<main${attributesFor(1, 1)} data-generated-elements="${elementCount}" data-generated-depth="${actualDepth}">
${phraseFor(1)}
`;
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk, 'utf8')) await once(stream, 'drain');
}

async function generate({ elementCount, requestedDepth, output }) {
  const actualDepth = Math.min(requestedDepth, elementCount);
  const outputPath = path.resolve(output);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;

  await mkdir(path.dirname(outputPath), { recursive: true });
  const stream = createWriteStream(temporaryPath, { encoding: 'utf8' });
  const completed = finished(stream);
  let groupCount = 0;

  try {
    await writeChunk(stream, documentStart(elementCount, actualDepth));

    let nextId = 2;
    const deepBranchLength = actualDepth - 1;

    if (deepBranchLength > 0) {
      const containers = [];
      for (let offset = 0; offset < deepBranchLength - 1; offset += 1) {
        const id = nextId + offset;
        const container = containerStart(id, offset + 2, 0);
        containers.push(container);
        await writeChunk(stream, container.start);
      }

      const leafId = nextId + deepBranchLength - 1;
      await writeChunk(stream, textBranchMarkup(leafId, 1, actualDepth, 0));

      for (let index = containers.length - 1; index >= 0; index -= 1) {
        await writeChunk(stream, containers[index].end);
      }
      nextId += deepBranchLength;
    }

    let target = 1;
    while (nextId <= elementCount) {
      const remaining = elementCount - nextId + 1;
      const groupSize = Math.min(96, remaining);
      const desiredWrapperDepth = 1 + (groupCount % 3);
      const wrapperDepth = Math.min(desiredWrapperDepth, actualDepth - 2, groupSize - 1);
      const containers = [];

      for (let offset = 0; offset < wrapperDepth; offset += 1) {
        const container = containerStart(nextId, offset + 2, groupCount + 1);
        containers.push(container);
        await writeChunk(stream, container.start);
        nextId += 1;
      }

      let groupBudget = groupSize - wrapperDepth;
      const maximumTextBranchLength = actualDepth - wrapperDepth - 1;
      while (groupBudget > 0) {
        const preferredLength = target % 16 === 15 ? 1 : 2 + (target % 4);
        const branchLength = Math.min(preferredLength, maximumTextBranchLength, groupBudget);
        const level = wrapperDepth + 2;
        await writeChunk(stream, textBranchMarkup(nextId, branchLength, level, target));
        nextId += branchLength;
        groupBudget -= branchLength;
        target += 1;
      }

      for (let index = containers.length - 1; index >= 0; index -= 1) {
        await writeChunk(stream, containers[index].end);
      }
      groupCount += 1;
    }

    await writeChunk(stream, '</main>\n</body>\n</html>\n');
    stream.end();
    await completed;
    await rename(temporaryPath, outputPath);
  } catch (error) {
    stream.destroy();
    await completed.catch(() => {});
    await rm(temporaryPath, { force: true });
    throw error;
  }

  return { outputPath, actualDepth, groupCount };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  if (options.help) {
    console.log(HELP);
    return;
  }

  try {
    const result = await generate(options);
    const relativeOutput = path.relative(process.cwd(), result.outputPath) || path.basename(result.outputPath);
    const directory = path.dirname(relativeOutput);
    const urlPath = encodeURIComponent(path.basename(result.outputPath));

    console.log(`Generated ${options.elementCount.toLocaleString('en-US')} body elements in ${relativeOutput}`);
    console.log(`Maximum depth: ${result.actualDepth}; content groups: ${result.groupCount}`);
    console.log(`Serve: python3 -m http.server 8080 --directory ${shellQuote(directory)}`);
    console.log(`Open:  http://localhost:8080/${urlPath}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) await main();
