#!/usr/bin/env python3
"""Ask a neutral question about an image, for building/checking corpus labels."""
import base64
import json
import os
import sys
import urllib.request

from PIL import Image

img = sys.argv[1]
question = sys.argv[2] if len(sys.argv) > 2 else "What does this photo show? Be specific and brief."

key = [l.split("=", 1)[1].strip().strip('"') for l in open(os.path.expanduser("~/.config/tampercheck/.env")) if l.startswith("OPENROUTER_API_KEY")][0]
im = Image.open(img).convert("RGB")
if max(im.size) > 1600:
    s = 1600 / max(im.size)
    im = im.resize((round(im.size[0] * s), round(im.size[1] * s)), Image.LANCZOS)
import io
buf = io.BytesIO(); im.save(buf, "JPEG", quality=88)
b64 = base64.b64encode(buf.getvalue()).decode()

body = {"model": "google/gemini-3.8-flash", "max_tokens": 400, "temperature": 0,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": question},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}}]}]}
req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",
                             data=json.dumps(body).encode(),
                             headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
print(json.load(urllib.request.urlopen(req, timeout=180))["choices"][0]["message"]["content"])
