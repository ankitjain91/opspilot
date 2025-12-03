from PIL import Image, ImageDraw, ImageFilter, ImageOps
import sys

def create_squircle_mask(size, radius):
    mask = Image.new('L', size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), size], radius=radius, fill=255)
    return mask

def create_gradient(size, color1, color2):
    base = Image.new('RGBA', size, color1)
    top = Image.new('RGBA', size, color2)
    mask = Image.new('L', size)
    mask_data = []
    for y in range(size[1]):
        for x in range(size[0]):
            mask_data.append(int(255 * (y / size[1])))
    mask.putdata(mask_data)
    base.paste(top, (0, 0), mask)
    return base

def process_icon(input_path, output_path):
    target_size = (1024, 1024)
    radius = 180
    
    # 1. Create Background: Dark Blue Gradient
    # Deep Ocean Blue to slightly lighter/cyan-ish blue
    bg = create_gradient(target_size, (10, 25, 47, 255), (20, 50, 80, 255))
    
    # 2. Load and Process Logo
    try:
        logo = Image.open(input_path).convert("RGBA")
        
        # Trim whitespace
        bbox = logo.getbbox()
        if bbox:
            logo = logo.crop(bbox)
            
        # Resize logo to fit (e.g., 70% of icon size)
        icon_size = int(target_size[0] * 0.7)
        
        # Calculate aspect ratio to fit within icon_size x icon_size
        ratio = min(icon_size / logo.width, icon_size / logo.height)
        new_size = (int(logo.width * ratio), int(logo.height * ratio))
        logo = logo.resize(new_size, Image.Resampling.LANCZOS)
        
        # If logo is black/dark, invert it to white for contrast on dark bg?
        # The user's image seemed to be dark lines. Let's check center pixel or average.
        # Actually, let's just force it to white if it's not already.
        # Or better, just paste it. If it's the line art one, it might be black.
        # Let's try to colorize it to white/cyan if possible, but simple pasting is safer first.
        # Assuming the input is the transparent PNG they uploaded.
        
        # Center it
        bg_w, bg_h = target_size
        offset = ((bg_w - new_size[0]) // 2, (bg_h - new_size[1]) // 2)
        bg.paste(logo, offset, logo)
        
    except Exception as e:
        print(f"Error processing logo: {e}")
        return

    # 3. Apply Squircle Mask
    mask = create_squircle_mask(target_size, radius)
    output = Image.new('RGBA', target_size, (0, 0, 0, 0))
    output.paste(bg, (0, 0), mask)
    
    output.save(output_path)
    print(f"Created {output_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python process_icon.py <input> <output>")
        sys.exit(1)
    
    process_icon(sys.argv[1], sys.argv[2])
