"""Regenerate the synthetic example; contains no real application or account data."""
import importlib.util
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('annotate', root / 'scripts/annotate.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
font_path = module.choose_font(None, 'Example App')
font = lambda size: ImageFont.truetype(font_path, size)
image = Image.new('RGB', (1200, 800), '#f3f5f8')
draw = ImageDraw.Draw(image)
draw.rectangle((0, 0, 1200, 76), fill='white')
draw.text((42, 24), 'Example App', font=font(24), fill='#263247')
draw.text((780, 28), 'SYNTHETIC SCREENSHOT / DEMO', font=font(17), fill='#65738a')
draw.text((90, 120), 'Account settings', font=font(32), fill='#182338')
draw.text((90, 172), 'Manage a sample profile and notification preferences.', font=font(19), fill='#64748b')
draw.rounded_rectangle((90, 230, 1110, 670), radius=16, fill='white', outline='#d9e0ea', width=2)
draw.text((130, 262), 'Display name', font=font(19), fill='#243047')
draw.rounded_rectangle((130, 300, 650, 352), radius=6, outline='#c8d2df', width=2)
draw.text((150, 314), 'Sample user', font=font(20), fill='#334155')
draw.text((130, 410), 'Email notifications', font=font(22), fill='#243047')
draw.text((130, 450), 'Receive a summary when your settings change.', font=font(18), fill='#64748b')
draw.rounded_rectangle((970, 414, 1034, 448), radius=17, fill='#94a3b8')
draw.ellipse((974, 418, 1000, 444), fill='white')
draw.line((130, 540, 1070, 540), fill='#e0e6ef', width=2)
draw.rounded_rectangle((760, 590, 900, 640), radius=7, outline='#b9c5d6', width=2)
draw.text((800, 604), 'Cancel', font=font(18), fill='#334155')
draw.rounded_rectangle((930, 590, 1080, 640), radius=7, fill='#315ee8')
draw.text((944, 604), 'Save changes', font=font(18), fill='white')
draw.text((90, 730), 'Illustration only. No real account, service or test result.', font=font(17), fill='#65738a')
image.save(root / 'examples/settings.png')
