import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const {
    untrustedData,
  } = await req.json();

  console.log('working on transaction');
  console.log(untrustedData);

  return NextResponse.redirect(process.env["HOST"] as string, {status: 302});
}

export const GET = POST;
