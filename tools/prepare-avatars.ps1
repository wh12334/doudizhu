# prepare-avatars.ps1  (ASCII ONLY - Windows PowerShell 5.1 reads .ps1 as GBK unless it has a BOM)
#
# Turns the three reference images in the workspace root into clean, square,
# transparent-background avatar PNGs under assets/avatars/:
#   landlord <- dc8b65da6f4cfe0dad3fe55adc6c68a9464410e420018-aXjVVd_fw658.jpg
#   farmer1  <- OIP-C.jpg
#   farmer2  <- OIP-C.webp          (converted to png with ffmpeg first)
#
# Algorithm: border colour histogram -> BFS flood fill from the image border
# through pixels matching a dominant border colour -> erode 1px -> feather the
# cut edge -> trim to content bbox -> pad to square -> high quality resize.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File tools/prepare-avatars.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'OIP-C.jpg'))) {
    throw "cannot locate the workspace root (expected OIP-C.jpg next to the tools folder)"
}

$outDir = Join-Path $root 'assets\avatars'
$tmpDir = Join-Path $PSScriptRoot '_tmp'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

# --- webp -> png (GDI+ cannot decode webp) ---
$webp = Join-Path $root 'OIP-C.webp'
$farmer2Png = Join-Path $tmpDir 'farmer2-src.png'
if (Test-Path $webp) {
    & ffmpeg -y -loglevel error -i $webp $farmer2Png
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed to convert the webp source" }
}

$cs = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class AvatarPrep
{
    private byte[] buf;
    private int stride;
    private int w;
    private int h;
    private List<int[]> bgColors = new List<int[]>();
    private int tol;
    private bool[] bgMask;

    public static string Process(string inPath, string outPath, int outSize, int tol, double margin, int erode)
    {
        AvatarPrep p = new AvatarPrep();
        return p.Run(inPath, outPath, outSize, tol, margin, erode);
    }

    private string Run(string inPath, string outPath, int outSize, int tolIn, double marginIn, int erode)
    {
        this.tol = tolIn;
        Bitmap src = new Bitmap(inPath);
        this.w = src.Width;
        this.h = src.Height;
        Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.CompositingMode = CompositingMode.SourceCopy;
            g.DrawImage(src, new Rectangle(0, 0, w, h));
        }
        src.Dispose();

        BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        this.stride = bd.Stride;
        this.buf = new byte[stride * h];
        Marshal.Copy(bd.Scan0, buf, 0, buf.Length);

        CollectBorderColors();

        // ---- flood fill the background from every border pixel ----
        this.bgMask = new bool[w * h];
        int[] queue = new int[w * h];
        int qh = 0, qt = 0;
        for (int x = 0; x < w; x++)
        {
            Seed(queue, ref qt, x, 0);
            Seed(queue, ref qt, x, h - 1);
        }
        for (int y = 0; y < h; y++)
        {
            Seed(queue, ref qt, 0, y);
            Seed(queue, ref qt, w - 1, y);
        }
        while (qh < qt)
        {
            int idx = queue[qh++];
            int px = idx % w;
            int py = idx / w;
            TryPush(queue, ref qt, px - 1, py);
            TryPush(queue, ref qt, px + 1, py);
            TryPush(queue, ref qt, px, py - 1);
            TryPush(queue, ref qt, px, py + 1);
        }
        int cleared = qt;

        // ---- drop stray opaque specks the flood fill could not reach ----
        int removed = RemoveSpecks();

        // ---- erode the opaque region (kills the bright fringe) ----
        for (int pass = 0; pass < erode; pass++)
        {
            bool[] next = new bool[w * h];
            for (int y = 0; y < h; y++)
            {
                for (int x = 0; x < w; x++)
                {
                    int idx = y * w + x;
                    if (bgMask[idx]) { next[idx] = true; continue; }
                    bool touches = (x > 0 && bgMask[idx - 1]) || (x < w - 1 && bgMask[idx + 1])
                        || (y > 0 && bgMask[idx - w]) || (y < h - 1 && bgMask[idx + w]);
                    next[idx] = touches;
                }
            }
            bgMask = next;
        }

        // ---- write alpha with a feathered cut edge ----
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                int idx = y * w + x;
                int o = y * stride + x * 4;
                if (bgMask[idx]) { buf[o + 3] = 0; continue; }
                bool edge = (x > 0 && bgMask[idx - 1]) || (x < w - 1 && bgMask[idx + 1])
                    || (y > 0 && bgMask[idx - w]) || (y < h - 1 && bgMask[idx + w]);
                buf[o + 3] = edge ? (byte)150 : (byte)255;
            }
        }

        Marshal.Copy(buf, 0, bd.Scan0, buf.Length);
        bmp.UnlockBits(bd);

        // ---- trim to content, pad to a square, resize ----
        int minX = w, minY = h, maxX = -1, maxY = -1;
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                if (!bgMask[y * w + x])
                {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) throw new Exception("nothing left after background removal: " + inPath);

        int bw = maxX - minX + 1;
        int bh = maxY - minY + 1;
        double side = Math.Max(bw, bh) * (1.0 + marginIn * 2.0);
        double scale = outSize / side;
        int dw = Math.Max(1, (int)Math.Round(bw * scale));
        int dh = Math.Max(1, (int)Math.Round(bh * scale));
        int dx = (outSize - dw) / 2;
        int dy = (outSize - dh) / 2;

        Bitmap outp = new Bitmap(outSize, outSize, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(outp))
        {
            g.CompositingMode = CompositingMode.SourceCopy;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);
            ImageAttributes ia = new ImageAttributes();
            ia.SetWrapMode(WrapMode.TileFlipXY);
            g.DrawImage(bmp, new Rectangle(dx, dy, dw, dh), minX, minY, bw, bh, GraphicsUnit.Pixel, ia);
        }
        outp.Save(outPath, ImageFormat.Png);
        outp.Dispose();
        bmp.Dispose();

        return string.Format("bgColors={0} cleared={1} specksRemoved={2} bbox={3},{4} {5}x{6} -> {7}x{7}",
            bgColors.Count, cleared, removed, minX, minY, bw, bh, outSize);
    }

    // Keep only sizeable connected opaque blobs (the body, a detached hat, ...)
    private int RemoveSpecks()
    {
        int[] label = new int[w * h];
        for (int i = 0; i < label.Length; i++) label[i] = -1;
        List<int> areas = new List<int>();
        int[] queue = new int[w * h];
        for (int start = 0; start < label.Length; start++)
        {
            if (bgMask[start] || label[start] >= 0) continue;
            int id = areas.Count;
            int qh = 0, qt = 0;
            queue[qt++] = start;
            label[start] = id;
            while (qh < qt)
            {
                int idx = queue[qh++];
                int px = idx % w;
                int py = idx / w;
                if (px > 0) Visit(label, queue, ref qt, id, idx - 1);
                if (px < w - 1) Visit(label, queue, ref qt, id, idx + 1);
                if (py > 0) Visit(label, queue, ref qt, id, idx - w);
                if (py < h - 1) Visit(label, queue, ref qt, id, idx + w);
            }
            areas.Add(qt);
        }
        if (areas.Count <= 1) return 0;

        int total = 0;
        for (int i = 0; i < areas.Count; i++) total += areas[i];
        int minArea = Math.Max(64, (int)(total * 0.002));

        int removed = 0;
        for (int i = 0; i < label.Length; i++)
        {
            if (label[i] < 0) continue;
            if (areas[label[i]] < minArea) { bgMask[i] = true; removed++; }
        }
        return removed;
    }

    private void Visit(int[] label, int[] queue, ref int qt, int id, int idx)
    {
        if (bgMask[idx] || label[idx] >= 0) return;
        label[idx] = id;
        queue[qt++] = idx;
    }

    private void CollectBorderColors()
    {
        Dictionary<int, int> hist = new Dictionary<int, int>();
        int total = 0;
        for (int x = 0; x < w; x++)
        {
            Bucket(hist, x, 0); total++;
            Bucket(hist, x, h - 1); total++;
        }
        for (int y = 0; y < h; y++)
        {
            Bucket(hist, 0, y); total++;
            Bucket(hist, w - 1, y); total++;
        }
        List<int> keys = new List<int>(hist.Keys);
        keys.Sort(delegate(int a, int b) { return hist[b].CompareTo(hist[a]); });
        int needed = Math.Max(4, (int)(total * 0.03));
        for (int i = 0; i < keys.Count && i < 4; i++)
        {
            if (hist[keys[i]] < needed) break;
            int k = keys[i];
            int r = (((k >> 10) & 31) << 3) | 4;
            int g = (((k >> 5) & 31) << 3) | 4;
            int b = ((k & 31) << 3) | 4;
            bgColors.Add(new int[] { r, g, b });
        }
        if (bgColors.Count == 0) throw new Exception("could not determine a background colour");
    }

    private void Bucket(Dictionary<int, int> hist, int x, int y)
    {
        int o = y * stride + x * 4;
        int key = ((buf[o + 2] >> 3) << 10) | ((buf[o + 1] >> 3) << 5) | (buf[o] >> 3);
        if (hist.ContainsKey(key)) hist[key] = hist[key] + 1;
        else hist[key] = 1;
    }

    private void Seed(int[] queue, ref int qt, int x, int y)
    {
        int idx = y * w + x;
        if (bgMask[idx]) return;
        if (!MatchesBackground(y * stride + x * 4)) return;
        bgMask[idx] = true;
        queue[qt++] = idx;
    }

    private void TryPush(int[] queue, ref int qt, int x, int y)
    {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        int idx = y * w + x;
        if (bgMask[idx]) return;
        if (!MatchesBackground(y * stride + x * 4)) return;
        bgMask[idx] = true;
        queue[qt++] = idx;
    }

    private bool MatchesBackground(int o)
    {
        for (int i = 0; i < bgColors.Count; i++)
        {
            int[] c = bgColors[i];
            int dr = buf[o + 2] - c[0]; if (dr < 0) dr = -dr;
            int dg = buf[o + 1] - c[1]; if (dg < 0) dg = -dg;
            int db = buf[o] - c[2]; if (db < 0) db = -db;
            if (dr <= tol && dg <= tol && db <= tol) return true;
        }
        return false;
    }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies 'System.Drawing'

$jobs = @(
    @{ name = 'landlord'; src = (Join-Path $root 'dc8b65da6f4cfe0dad3fe55adc6c68a9464410e420018-aXjVVd_fw658.jpg'); tol = 24; erode = 1 },
    @{ name = 'farmer1';  src = (Join-Path $root 'OIP-C.jpg'); tol = 42; erode = 1 },
    @{ name = 'farmer2';  src = $farmer2Png; tol = 42; erode = 1 }
)

foreach ($j in $jobs) {
    if (-not (Test-Path $j.src)) { Write-Warning ("missing source: " + $j.src); continue }
    $out = Join-Path $outDir ($j.name + '.png')
    $info = [AvatarPrep]::Process($j.src, $out, 512, $j.tol, 0.06, $j.erode)
    Write-Host ("{0,-9} {1}" -f $j.name, $info)
}

Write-Host "`nDone. Avatars written to $outDir"
Get-ChildItem $outDir | Select-Object Name, Length | Format-Table -AutoSize
