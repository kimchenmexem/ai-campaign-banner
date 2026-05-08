import { NextResponse } from "next/server";

export async function POST(_request: Request) {
  return NextResponse.json(
    { ok: false, error: "not_implemented" },
    { status: 501 },
  );
}
