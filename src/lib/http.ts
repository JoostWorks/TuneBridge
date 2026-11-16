import { NextResponse } from "next/server";
import { publicUrl } from "./env";
export const redirectTo = (path: string) => NextResponse.redirect(publicUrl(path), 303);
export const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });
export const notFound = () => NextResponse.json({ error: "not found" }, { status: 404 });
export const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });
