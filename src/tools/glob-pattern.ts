const REGEX_SPECIALS = /[.+^${}()|\\]/g;

export function globToRegExp(glob: string): RegExp {
  let source = '';

  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] as string;

    if (char === '*') {
      const consumed = appendStar(glob, index);
      source += consumed.source;
      index += consumed.skip;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    if (char === '[') {
      const end = glob.indexOf(']', index);
      if (end === -1) {
        source += '\\[';
      } else {
        source += glob.slice(index, end + 1);
        index = end;
      }
      continue;
    }

    if (char === '{') {
      const end = glob.indexOf('}', index);
      if (end === -1) {
        source += '\\{';
      } else {
        const alternatives = glob.slice(index + 1, end).split(',');
        source += `(?:${alternatives.map(escapeLiteral).join('|')})`;
        index = end;
      }
      continue;
    }

    source += escapeLiteral(char);
  }

  return new RegExp(`^${source}$`);
}

export function matchesGlob(glob: string, candidate: string): boolean {
  return globToRegExp(glob).test(candidate);
}

function appendStar(glob: string, index: number): { source: string; skip: number } {
  const isDoubleStar = glob[index + 1] === '*';

  if (!isDoubleStar) return { source: '[^/]*', skip: 0 };
  if (glob[index + 2] === '/') return { source: '(?:.*/)?', skip: 2 };
  return { source: '.*', skip: 1 };
}

function escapeLiteral(text: string): string {
  return text.replace(REGEX_SPECIALS, '\\$&');
}
