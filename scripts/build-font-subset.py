#!/usr/bin/env python3
"""字体子集流水线：Noto Sans SC 可变字体 → AidcpSans SC 静态子集（Regular/Bold）。

源字体出处（provenance）：
    Noto Sans SC 可变字体（wght 轴，OFL 1.1），来自 Google 官方 notofonts 发行
    （google/fonts 仓 ofl/notosanssc/NotoSansSC[wght].ttf，亦即 Noto CJK 项目的
    简体中文无衬线，衍生自 Adobe Source Han Sans）。许可为 SIL Open Font License 1.1，
    允许子集化与修改，但 "Noto"/"Source" 为保留字体名（Reserved Font Name）——
    因此本脚本将 name 表家族名改写为 "AidcpSans SC" 以合规（OFL §3）。

产物（写入 --out 目录，默认随仓提交）：
    AidcpSansSC-Regular.ttf / AidcpSansSC-Bold.ttf   wght 分别 pin 在 400/700 的子集
    font-manifest.json                                unitsPerEm + 每码点 advance + sha256
    OFL.txt                                           版权行（读自源字体 name 表）+ OFL 1.1 全文

manifest 是云端确定性排版的引擎：src/render/text-metrics.ts 只读 manifest 里的
advance 宽度做断行/字号阶梯计算，运行时零字体解析（design D8/D11）。

码点集合：
    ASCII 0x20-0x7E + Latin-1 标点子集 + CJK 标点 U+3000-U+303F + 全角形式 U+FF01-U+FF5E
    + GB2312 全部汉字（枚举合法字节对解码，6763 字）+ 〇/·/—/…/引号等补充
    + 《通用规范汉字表》8105 字（联网 best-effort 拉取，15s 超时；失败则退化为 GB2312 集并告警）。

确定性：TTFont 以 recalcTimestamp=False 载入（保留源字体时间戳），同一源字体 +
同一 fontTools 版本重跑产物字节一致（8105 拉取成功与否会影响码点集，属已知网络前提）。

用法：
    python scripts/build-font-subset.py --source /path/to/NotoSansSC[wght].ttf --out assets/fonts

依赖：fontTools >= 4.60（varLib.instancer + subset）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FAMILY_NAME = "AidcpSans SC"

# 《通用规范汉字表》8105 字表候选源（按序尝试；仓库现行文件为 data/characters.json，
# data/data.json 为历史路径保留在前以兼容旧镜像）。
GSCC_8105_URLS = [
    "https://raw.githubusercontent.com/jaywcjlove/"
    "table-of-general-standard-chinese-characters/main/data/data.json",
    "https://raw.githubusercontent.com/jaywcjlove/"
    "table-of-general-standard-chinese-characters/main/data/characters.json",
]

# Latin-1 标点/符号子集（正文可能出现的少量西文符号）。
LATIN1_PUNCT = [
    0x00A0,  # nbsp
    0x00A1, 0x00A2, 0x00A3, 0x00A5, 0x00A7, 0x00A9, 0x00AB, 0x00AC,
    0x00AE, 0x00B0, 0x00B1, 0x00B7, 0x00BB, 0x00BF, 0x00D7, 0x00F7,
]

# 通用标点补充：〇、·（已含于 Latin-1 子集）、破折号、省略号、弯引号、项目符等。
EXTRA_PUNCT = [
    0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D,
    0x2022, 0x2026, 0x2030, 0x2103, 0x3007,
]

# OFL 1.1 标准全文（版权行由源字体 name 表 nameID 0 读出后置于其上）。
OFL_11_TEXT = """\
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
"""


def gb2312_hanzi_codepoints() -> set[int]:
    """枚举 GB2312 汉字区（行 0xB0-0xF7 × 列 0xA1-0xFE）全部合法字节对，解码为码点。"""
    cps: set[int] = set()
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes([hi, lo]).decode("gb2312")
            except UnicodeDecodeError:
                continue
            if len(ch) == 1:
                cps.add(ord(ch))
    return cps


def fetch_gscc_8105(timeout: float = 15.0) -> set[int]:
    """拉取《通用规范汉字表》8105 字表；对任意 JSON 结构递归收集 CJK 表意文字码点。"""
    data = None
    last_err: Exception | None = None
    for url in GSCC_8105_URLS:
        req = urllib.request.Request(url, headers={"User-Agent": "aidcp-font-subset/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            break
        except Exception as err:  # noqa: BLE001 —— 逐个候选源降级
            last_err = err
    if data is None:
        raise last_err if last_err else RuntimeError("no 8105 source available")

    cps: set[int] = set()

    def is_cjk(cp: int) -> bool:
        return (
            0x3400 <= cp <= 0x4DBF  # Ext A
            or 0x4E00 <= cp <= 0x9FFF  # CJK Unified
            or 0xF900 <= cp <= 0xFAFF  # Compatibility Ideographs
            or 0x20000 <= cp <= 0x2FA1F  # Ext B+
        )

    def walk(node: object) -> None:
        if isinstance(node, str):
            for ch in node:
                cp = ord(ch)
                if is_cjk(cp):
                    cps.add(cp)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            for value in node.values():
                walk(value)

    walk(data)
    return cps


def build_codepoint_set() -> tuple[set[int], bool]:
    """组装目标码点集合；返回 (码点集, 是否成功并入 8105 表)。"""
    cps: set[int] = set()
    cps.update(range(0x0020, 0x007F))  # ASCII 可见区 + 空格
    cps.update(LATIN1_PUNCT)
    cps.update(range(0x3000, 0x3040))  # CJK 标点（含 U+3007 〇）
    cps.update(range(0xFF01, 0xFF5F))  # 全角形式
    cps.update(range(0xFFE0, 0xFFE6))  # 全角货币/符号（￠￡￣￤￥）
    cps.update(EXTRA_PUNCT)
    cps.update(gb2312_hanzi_codepoints())

    gscc_ok = False
    try:
        gscc = fetch_gscc_8105()
        if len(gscc) < 5000:
            raise ValueError(f"8105 list suspiciously small: {len(gscc)} chars")
        cps.update(gscc)
        gscc_ok = True
        print(f"[build-font-subset] 8105 list fetched: {len(gscc)} hanzi merged")
    except Exception as err:  # noqa: BLE001 —— 网络失败退化为 GB2312 集
        print(
            "[build-font-subset] WARNING: failed to fetch 通用规范汉字表 8105 "
            f"({err}); proceeding with GB2312 hanzi set only",
            file=sys.stderr,
        )
    return cps, gscc_ok


def rewrite_name_table(font: TTFont, subfamily: str) -> None:
    """改写 name 表为 AidcpSans SC（nameID 1/2/3/4/6/16/17，OFL 保留名合规）。"""
    name = font["name"]
    postscript = FAMILY_NAME.replace(" ", "") + "-" + subfamily
    full = f"{FAMILY_NAME} {subfamily}"
    unique = f"{full}; aidcp subset of Noto Sans SC (OFL 1.1)"
    values = {
        1: FAMILY_NAME,
        2: subfamily,
        3: unique,
        4: full,
        6: postscript,
        16: FAMILY_NAME,
        17: subfamily,
    }
    for name_id, value in values.items():
        name.removeNames(nameID=name_id)
        name.setName(value, name_id, 3, 1, 0x409)  # Windows / Unicode BMP / en-US
        name.setName(value, name_id, 1, 0, 0)  # Macintosh / Roman / English


def apply_weight_metadata(font: TTFont, weight: int, subfamily: str) -> None:
    """固化 OS/2 usWeightClass 与 fsSelection / head.macStyle（resvg 按此选粗细）。"""
    os2 = font["OS/2"]
    head = font["head"]
    os2.usWeightClass = weight
    if subfamily == "Bold":
        os2.fsSelection = (os2.fsSelection & ~0x40) | 0x20
        head.macStyle |= 0x01
    else:
        os2.fsSelection = (os2.fsSelection & ~0x21) | 0x40
        head.macStyle &= ~0x03


def build_weight(
    source: Path, out_dir: Path, weight: int, subfamily: str, unicodes: set[int]
) -> tuple[dict, int, str]:
    """单个字重流水线：instancer pin wght → subset → 改名 → 保存；返回 (manifest 段, upem, 版权行)。"""
    font = TTFont(str(source), recalcTimestamp=False)
    copyright_line = ""
    record = font["name"].getName(0, 3, 1, 0x409) or font["name"].getName(0, 1, 0, 0)
    if record is not None:
        copyright_line = record.toUnicode()

    # 1) 可变字体 pin 到静态字重（instancer 同步应用 gvar/HVAR 增量，hmtx 为该字重真实 advance）。
    instancer.instantiateVariableFont(font, {"wght": weight}, inplace=True, updateFontNames=False)

    # 2) 子集化：保留 cmap/glyf/hmtx 等渲染必需表；丢弃布局特性表（GSUB/GPOS 等）——
    #    云端排版按 manifest advance 逐字形推进，去掉 kerning/替换反而与测量模型一致。
    options = Options()
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
    options.name_languages = [0x409]
    options.recalc_timestamp = False
    options.hinting = False
    options.drop_tables += [
        "GSUB", "GPOS", "GDEF", "MATH", "meta", "FFTM", "STAT",
        "vhea", "vmtx", "VORG",
    ]
    subsetter = Subsetter(options=options)
    subsetter.populate(unicodes=sorted(unicodes))
    subsetter.subset(font)

    # 3) 改名 + 字重元数据固化。
    rewrite_name_table(font, subfamily)
    apply_weight_metadata(font, weight, subfamily)

    # 4) 保存并回读 advance 清单（cmap + hmtx，单位 font units）。
    file_name = f"AidcpSansSC-{subfamily}.ttf"
    out_path = out_dir / file_name
    font.save(str(out_path))

    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    advances = {
        format(cp, "x"): int(hmtx[glyph_name][0]) for cp, glyph_name in cmap.items()
    }
    upem = int(font["head"].unitsPerEm)
    sha256 = hashlib.sha256(out_path.read_bytes()).hexdigest()
    font.close()

    print(
        f"[build-font-subset] {file_name}: {out_path.stat().st_size} bytes, "
        f"{len(advances)} codepoints covered, sha256={sha256[:16]}…"
    )
    return (
        {"file": file_name, "sha256": sha256, "advances": advances},
        upem,
        copyright_line,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Build AidcpSans SC font subset assets")
    parser.add_argument("--source", required=True, help="path to NotoSansSC[wght].ttf")
    parser.add_argument("--out", required=True, help="output dir, e.g. assets/fonts")
    args = parser.parse_args()

    source = Path(args.source)
    out_dir = Path(args.out)
    if not source.is_file():
        parser.error(f"source font not found: {source}")
    out_dir.mkdir(parents=True, exist_ok=True)

    unicodes, gscc_ok = build_codepoint_set()
    print(f"[build-font-subset] requested codepoints: {len(unicodes)}")

    regular, upem_r, copyright_line = build_weight(source, out_dir, 400, "Regular", unicodes)
    bold, upem_b, _ = build_weight(source, out_dir, 700, "Bold", unicodes)
    if upem_r != upem_b:
        raise RuntimeError(f"unitsPerEm mismatch between weights: {upem_r} vs {upem_b}")

    manifest = {
        "unitsPerEm": upem_r,
        "generatedBy": "scripts/build-font-subset.py",
        "sourceNote": (
            "Subset of Noto Sans SC variable font (SIL OFL 1.1, Google notofonts / "
            "Adobe Source Han Sans lineage), renamed to 'AidcpSans SC' for OFL "
            "reserved-name compliance; wght pinned at 400/700; codepoints = ASCII + "
            "Latin-1 punct subset + CJK punct + fullwidth forms + GB2312 hanzi + "
            "通用规范汉字表 8105 (best-effort) + extras"
        ),
        "weights": {"regular": regular, "bold": bold},
    }
    manifest_path = out_dir / "font-manifest.json"
    with manifest_path.open("w", encoding="utf-8") as fh:
        json.dump(manifest, fh, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
        fh.write("\n")
    print(
        f"[build-font-subset] font-manifest.json: {manifest_path.stat().st_size} bytes"
    )

    ofl_path = out_dir / "OFL.txt"
    header = copyright_line or (
        "Copyright 2014-2021 Adobe (http://www.adobe.com/), "
        "with Reserved Font Name 'Source'."
    )
    ofl_path.write_text(header + "\n\n" + OFL_11_TEXT, encoding="utf-8")

    print(
        "[build-font-subset] done. "
        f"gscc8105={'merged' if gscc_ok else 'FALLBACK(GB2312 only)'}, "
        f"coverage regular={len(regular['advances'])} bold={len(bold['advances'])}"
    )


if __name__ == "__main__":
    main()
