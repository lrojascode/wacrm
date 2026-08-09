"use client";

import { useState } from "react";
import { Download, FileJson, FileSpreadsheet, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";
import { downloadBlob } from "@/lib/export/csv";

/**
 * Owner-only export settings panel — CSV export and full JSONL export for AI.
 */
export function ExportSettings() {
  const { isOwner } = useAuth();
  const t = useTranslations("Settings.export");
  const [exportingCsv, setExportingCsv] = useState(false);
  const [exportingJsonl, setExportingJsonl] = useState(false);

  const handleDownloadCsv = async () => {
    setExportingCsv(true);
    try {
      const res = await fetch("/api/contacts/export");
      if (!res.ok) {
        toast.error(t("exportError"));
        return;
      }
      const text = await res.text();
      downloadBlob("contacts-export.csv", text, res.headers.get("content-type") || "text/csv;charset=utf-8;");
    } catch {
      toast.error(t("exportError"));
    } finally {
      setExportingCsv(false);
    }
  };

  const handleDownloadJsonl = async () => {
    setExportingJsonl(true);
    try {
      const res = await fetch("/api/export/full");
      if (!res.ok) {
        toast.error(t("exportError"));
        return;
      }
      const text = await res.text();
      downloadBlob("full-crm-export.jsonl", text, res.headers.get("content-type") || "application/x-ndjson;charset=utf-8;");
    } catch {
      toast.error(t("exportError"));
    } finally {
      setExportingJsonl(false);
    }
  };

  return (
    <section className="max-w-2xl space-y-6 animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      {/* CSV Export Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <FileSpreadsheet className="size-4 text-primary" />
            {t("csvTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("csvDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t("csvNotice")}
          </p>
          <Button
            onClick={handleDownloadCsv}
            disabled={!isOwner || exportingCsv}
            variant="outline"
            className="border-border text-foreground hover:bg-muted"
          >
            {exportingCsv ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {t("downloadCsv")}
          </Button>
        </CardContent>
      </Card>

      {/* Full AI JSONL Export Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <FileJson className="size-4 text-primary" />
            {t("jsonlTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("jsonlDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t("jsonlDetails")}
          </p>
          <Button
            onClick={handleDownloadJsonl}
            disabled={!isOwner || exportingJsonl}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {exportingJsonl ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {t("downloadJsonl")}
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}
