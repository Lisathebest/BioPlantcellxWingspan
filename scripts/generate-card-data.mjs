import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from '/Users/lisa/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';

const workbookPath = '/Users/lisa/Desktop/project/bio-cell/outputs/01a0a269-71e3-7330-8d17-c3040afbcf09/bio-cell-card-deck.xlsx';
const outputPath = '/Users/lisa/Desktop/project/bio-cell/dist/card-data.js';

const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const textOrNull = value => value === null || value === undefined || value === '' ? null : String(value);

const input = await FileBlob.load(workbookPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const cardSheet = workbook.worksheets.getItem('Organelle cards');
const goalSheet = workbook.worksheets.getItem('Cell Needs');

const cardRows = cardSheet.getRange('A9:AN64').values.filter(row => row[0] && typeof row[4] === 'number');
const cards = cardRows.map(row => ({
  id: String(row[0]),
  name: String(row[1]),
  icon: textOrNull(row[2]),
  pathway: String(row[3]),
  order: numberOrNull(row[4]),
  cardClass: String(row[5]),
  prerequisite: textOrNull(row[6]),
  buildEffect: textOrNull(row[7]),
  energyCost: numberOrNull(row[8]),
  proteinCost: numberOrNull(row[9]),
  totalBuildCost: numberOrNull(row[10]),
  activationTrigger: textOrNull(row[11]),
  gameplayEffect: textOrNull(row[12]),
  biologicalFunction: textOrNull(row[13]),
  inputs: {
    light: numberOrNull(row[14]),
    water: numberOrNull(row[15]),
    co2: numberOrNull(row[16]),
    amino: numberOrNull(row[17]),
    glucose: numberOrNull(row[18]),
    energy: numberOrNull(row[19]),
    protein: numberOrNull(row[20]),
  },
  outputs: {
    water: numberOrNull(row[21]),
    glucose: numberOrNull(row[22]),
    energy: numberOrNull(row[23]),
    protein: numberOrNull(row[24]),
    finished: numberOrNull(row[25]),
  },
  waterCapPlus: numberOrNull(row[26]),
  stability: numberOrNull(row[27]),
  cardsDrawn: numberOrNull(row[28]),
  version: textOrNull(row[29]),
  extraCosts: {
    water: numberOrNull(row[30]),
    glucose: numberOrNull(row[31]),
    amino: numberOrNull(row[32]),
  },
}));

const goalRows = goalSheet.getRange('A9:H17').values.filter(row => row[0]);
const goals = goalRows.map(row => ({
  id: String(row[0]),
  phase: textOrNull(row[1]),
  name: textOrNull(row[2]),
  scoreBasedOn: textOrNull(row[3]),
  scoringMethod: textOrNull(row[4]),
  encourages: textOrNull(row[5]),
  basis: textOrNull(row[6]),
  example: textOrNull(row[7]),
}));

const uniqueVersions = new Set(cards.map(card => card.version).filter(Boolean)).size;
const payload = `/* Generated from bio-cell-card-deck.xlsx. Run scripts/generate-card-data.mjs to refresh. */\nwindow.CELLWORKS_CATALOG_META = ${JSON.stringify({ physicalCardCount: cards.length, versionCount: uniqueVersions, goalCount: goals.length })};\nwindow.CELLWORKS_CARD_CATALOG = ${JSON.stringify(cards)};\nwindow.CELLWORKS_GOAL_CATALOG = ${JSON.stringify(goals)};\n`;
await fs.writeFile(outputPath, payload, 'utf8');
console.log(JSON.stringify({ outputPath, physicalCardCount: cards.length, versionCount: uniqueVersions, goalCount: goals.length }));
