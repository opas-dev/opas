// ABOUTME: Exercises the production member-password verifier inside native workerd.
// ABOUTME: Exposes one bearer-protected verification per request for external timing.

import {
  memberPasswordPolicy,
  memberPasswordScheme,
  verifyMemberPassword,
} from "../../../src/auth/member-password";

type Environment = Readonly<{ BENCHMARK_AUTH_TOKEN: string }>;

const benchmarkPassword = "Correct horse 🐴 battery staple";
const benchmarkVerifier = Object.freeze({
  digest: "78bLnh4GPF_lM-Tc41tAtF3gX7Ghu_cAXtk7UUMO5cs",
  iterations: memberPasswordPolicy.iterations,
  salt: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
});

export default {
  async fetch(request: Request, environment: Environment) {
    const url = new URL(request.url);
    const benchmarkToken = environment.BENCHMARK_AUTH_TOKEN;
    if (url.pathname === "/health") return new Response("ready");
    if (
      url.pathname !== "/verify" ||
      request.method !== "POST" ||
      typeof benchmarkToken !== "string" ||
      benchmarkToken.length < 24 ||
      request.headers.get("authorization") !== `Bearer ${benchmarkToken}`
    ) {
      return new Response("Not Found\n", { status: 404 });
    }

    const verified = await verifyMemberPassword(
      benchmarkPassword,
      benchmarkVerifier,
    );
    if (!verified) return new Response("Verification failed\n", { status: 500 });

    return Response.json({
      iterations: benchmarkVerifier.iterations,
      scheme: memberPasswordScheme,
      verified,
    });
  },
} satisfies ExportedHandler<Environment>;
