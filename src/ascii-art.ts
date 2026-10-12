import fs from 'node:fs/promises';
import path from 'node:path';
import { chatCharacterLength } from './chat.js';

export interface AsciiArt {
  name: string;
  filePath: string;
  content: string;
  characterCount: number;
  lineCount: number;
}

export class AsciiArtStore {
  constructor(
    private readonly directory: string,
    private readonly chatLimit = 450,
  ) {}

  async list(): Promise<string[]> {
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
      .map((entry) => entry.name.slice(0, -4))
      .sort();
  }

  async load(name: string): Promise<AsciiArt> {
    if (!/^[a-zA-Z0-9_-]+$/u.test(name)) throw new Error('Ungültiger ASCII-Art-Name.');
    const filePath = path.join(this.directory, `${name}.txt`);
    const content = await fs.readFile(filePath, 'utf8');
    return {
      name,
      filePath,
      content,
      characterCount: chatCharacterLength(content),
      lineCount: content.split('\n').length,
    };
  }

  async loadForChat(name: string): Promise<AsciiArt> {
    const art = await this.load(name);
    if (art.characterCount > this.chatLimit) {
      throw new Error(`${name}.txt hat ${art.characterCount} Zeichen und überschreitet das Chatlimit von ${this.chatLimit}.`);
    }
    return art;
  }

  async splitForChat(name: string): Promise<string[]> {
    const art = await this.load(name);
    const lines = art.content.split('\n');
    const chunks: string[] = [];
    let current = '';
    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;
      if (chatCharacterLength(candidate) > this.chatLimit) {
        if (current) chunks.push(current);
        if (chatCharacterLength(line) > this.chatLimit) {
          throw new Error(`Eine Zeile in ${name}.txt überschreitet das Chatlimit.`);
        }
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current || chunks.length === 0) chunks.push(current);
    return chunks;
  }
}
