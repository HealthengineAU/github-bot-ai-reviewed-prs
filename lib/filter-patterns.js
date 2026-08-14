// GitHub-Actions-style filter patterns, as used by on.push.branches:
//   *   matches zero or more characters, but not "/"
//   **  matches zero or more of any character
//   ?   matches zero or one of the preceding character
//   +   matches one or more of the preceding character
//   []  matches one character listed in the brackets or included in ranges,
//       or the bracketed text literally — so bot logins like "dependabot[bot]"
//       can be written as-is
//   !   at the start of a pattern negates a previous match
//
// Patterns are evaluated in order and the LAST matching pattern wins; a value
// matched by no pattern is not included. So ["**", "!test/**"] means
// "everything except test/…", and (as in GitHub Actions) a list of only
// negative patterns matches nothing. Matching is case-insensitive, since
// GitHub repo names and logins are too.

function toRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?" || char === "+") {
      out += char;
    } else if (char === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
      } else {
        const group = glob.slice(i, end + 1);
        const literal = group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out += `(?:${group}|${literal})`;
        i = end;
      }
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

// Compiles raw pattern strings into [{ negate, regex, source }], dropping
// (with a warning) any pattern that doesn't compile.
export function compileFilterPatterns(rawPatterns) {
  const compiled = [];
  for (const source of rawPatterns) {
    const negate = source.startsWith("!");
    const glob = negate ? source.slice(1) : source;
    try {
      compiled.push({ negate, regex: toRegExp(glob), source });
    } catch {
      console.warn(`[filter-patterns] Ignoring invalid pattern "${source}"`);
    }
  }
  return compiled;
}

export function matchesFilterPatterns(patterns, value) {
  let matched = false;
  for (const { negate, regex } of patterns) {
    if (regex.test(value)) {
      matched = !negate;
    }
  }
  return matched;
}
