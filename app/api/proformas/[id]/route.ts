import { NextResponse } from "next/server";
import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";
import { PDFDocument } from "pdf-lib";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const PRODUCT_PDF_BUCKET = "product-pdfs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const RENDER_APP_URL =
  process.env.RENDER_APP_URL ?? "https://bio-cotizador.onrender.com";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let browser: puppeteer.Browser | null = null;

  try {
    const resolved = await params;
    const id = Number(resolved.id);

    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: "ID inválido" }, { status: 400 });
    }

    if (
      !process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      return NextResponse.json(
        { error: "Faltan variables de entorno" },
        { status: 500 }
      );
    }

    const [{ data: proforma, error: proErr }, { data: rawItems, error: itemsErr }] =
      await Promise.all([
        supabase.from("proformas").select("id, number").eq("id", id).single(),
        supabase.from("proforma_items").select("product_id").eq("proforma_id", id),
      ]);

    if (proErr || !proforma) {
      return NextResponse.json(
        { error: proErr?.message ?? "No se encontró la proforma" },
        { status: 404 }
      );
    }

    if (itemsErr) {
      return NextResponse.json({ error: itemsErr.message }, { status: 500 });
    }

    const productIds = Array.from(
      new Set(
        (rawItems ?? [])
          .map((row: any) => row?.product_id)
          .filter((x: any) => Number.isFinite(x))
      )
    ) as number[];

    const [productsResult, mainPdf] = await Promise.all([
      productIds.length > 0
        ? supabase.from("products").select("id, pdf_path").in("id", productIds)
        : Promise.resolve({ data: [], error: null }),

      (async () => {
        browser = await puppeteer.launch({
          args: chromium.args,
          executablePath: await chromium.executablePath(),
          headless: true,
        });

        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on("request", (request: any) => {
          const type = request.resourceType();
          if (["font", "media"].includes(type)) {
            request.abort();
          } else {
            request.continue();
          }
        });

        await page.goto(`${RENDER_APP_URL}/proformas/${id}/pdf`, {
          waitUntil: "networkidle0",
          timeout: 25000,
        });

        const pdf = await page.pdf({
          format: "A4",
          printBackground: true,
          margin: { top: "0cm", right: "0cm", bottom: "0cm", left: "0cm" },
        });

        await browser.close();
        browser = null;

        return pdf;
      })(),
    ]);

    if (productsResult.error) {
      return NextResponse.json(
        { error: productsResult.error.message },
        { status: 500 }
      );
    }

    const pdfPaths = Array.from(
      new Set(
        (productsResult.data ?? [])
          .map((p: any) => p?.pdf_path ?? null)
          .filter(Boolean)
      )
    ) as string[];

    const annexBuffers = await Promise.allSettled(
      pdfPaths.map(async (pdfPath) => {
        const { data, error } = await supabase.storage
          .from(PRODUCT_PDF_BUCKET)
          .download(pdfPath);

        if (error || !data) return null;
        return data.arrayBuffer();
      })
    );

    const mergedPdf = await PDFDocument.create();

    const mainDoc = await PDFDocument.load(mainPdf);
    const mainPages = await mergedPdf.copyPages(mainDoc, mainDoc.getPageIndices());
    mainPages.forEach((p) => mergedPdf.addPage(p));

    for (const result of annexBuffers) {
      if (result.status !== "fulfilled" || !result.value) continue;

      try {
        const annexDoc = await PDFDocument.load(result.value);
        const annexPages = await mergedPdf.copyPages(
          annexDoc,
          annexDoc.getPageIndices()
        );
        annexPages.forEach((p) => mergedPdf.addPage(p));
      } catch {}
    }

    const finalPdfBytes = await mergedPdf.save();

    return new NextResponse(Buffer.from(finalPdfBytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="proforma-${String(
          proforma.number
        ).padStart(8, "0")}.pdf"`,
      },
    });
  } catch (error: any) {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }

    return NextResponse.json(
      { error: error?.message ?? "No se pudo generar el PDF" },
      { status: 500 }
    );
  }
}
