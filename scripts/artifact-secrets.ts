// ABOUTME: Finds secret values after the encodings used by web build tools and serializers.
// ABOUTME: Normalizes escaped artifact bytes before deployment safety checks compare them.
function decodePercentEscapes(contents: Buffer) {
  const source = contents.toString("latin1");
  const decoded = Buffer.allocUnsafe(source.length);
  let offset = 0;

  for (let index = 0; index < source.length; index += 1) {
    const escape = source.slice(index + 1, index + 3);
    if (source[index] === "%" && /^[\da-f]{2}$/iu.test(escape)) {
      decoded[offset] = Number.parseInt(escape, 16);
      offset += 1;
      index += 2;
      continue;
    }

    decoded[offset] = source.charCodeAt(index);
    offset += 1;
  }

  return decoded.subarray(0, offset);
}

function decodeJavascriptEscapes(source: string) {
  const simpleEscapes: Readonly<Record<string, string>> = {
    '"': '"',
    "/": "/",
    "\\": "\\",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  };

  return source
    .replace(/\\u\{([\da-f]{1,6})\}/giu, (match, code: string) => {
      const value = Number.parseInt(code, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : match;
    })
    .replace(/\\u([\da-f]{4})/giu, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/\\x([\da-f]{2})/giu, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/\\(["\\/bfnrt])/gu, (_match, escape: string) =>
      simpleEscapes[escape] ?? escape,
    );
}

function decodeHtmlEntities(source: string) {
  const namedEntities: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };

  return source
    .replace(/&#x([\da-f]+);/giu, (match, code: string) => {
      const value = Number.parseInt(code, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : match;
    })
    .replace(/&#(\d+);/gu, (match, code: string) => {
      const value = Number.parseInt(code, 10);
      return value <= 0x10ffff ? String.fromCodePoint(value) : match;
    })
    .replace(/&(amp|apos|gt|lt|quot);/giu, (_match, name: string) =>
      namedEntities[name.toLowerCase()] ?? name,
    );
}

export function encodedSecretForms(value: string) {
  const base64 = Buffer.from(value).toString("base64");
  const percentEncoded = encodeURIComponent(value);

  return [
    value,
    JSON.stringify(value).slice(1, -1),
    percentEncoded,
    percentEncoded.replaceAll("%20", "+"),
    base64,
    base64.replace(/=+$/u, ""),
    Buffer.from(value).toString("base64url"),
  ].filter(
    (candidate, index, candidates) =>
      Buffer.byteLength(candidate) >= 4 && candidates.indexOf(candidate) === index,
  );
}

export function artifactContentForms(contents: Buffer) {
  const forms = [contents];
  let current = contents;

  for (let round = 0; round < 3; round += 1) {
    const percentDecoded = decodePercentEscapes(current);
    if (!percentDecoded.equals(current)) forms.push(percentDecoded);
    const formDecoded = decodePercentEscapes(
      Buffer.from(current.toString("latin1").replaceAll("+", " "), "latin1"),
    );
    if (!formDecoded.equals(current) && !formDecoded.equals(percentDecoded)) {
      forms.push(formDecoded);
    }

    const escapedText = decodeHtmlEntities(
      decodeJavascriptEscapes(percentDecoded.toString("utf8")),
    );
    const escaped = Buffer.from(escapedText);
    if (!escaped.equals(percentDecoded)) forms.push(escaped);
    const escapedForm = Buffer.from(
      decodeHtmlEntities(decodeJavascriptEscapes(formDecoded.toString("utf8"))),
    );
    if (!escapedForm.equals(formDecoded)) forms.push(escapedForm);
    if (escaped.equals(current)) break;
    current = escaped;
  }

  return forms;
}
