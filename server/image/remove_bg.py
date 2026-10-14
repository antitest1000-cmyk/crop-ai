import sys
import io
import cv2
import numpy as np
from rembg import remove
from PIL import Image

def remove_edge_slivers(img: Image.Image) -> Image.Image:
    img_arr = np.array(img)
    if img_arr.shape[2] != 4:
        return img
        
    alpha = img_arr[:, :, 3]
    # Binarize alpha to find clear components
    _, thresh = cv2.threshold(alpha, 127, 255, cv2.THRESH_BINARY)
    
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(thresh, connectivity=8)
    if num_labels <= 1:
        return img
        
    # Find the largest component area (excluding background)
    largest_label = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
    largest_area = stats[largest_label, cv2.CC_STAT_AREA]
    
    h, w = alpha.shape
    final_mask = np.zeros_like(alpha, dtype=np.uint8)
    
    for i in range(1, num_labels):
        area = stats[i, cv2.CC_STAT_AREA]
        
        # Always keep the largest component
        if i == largest_label:
            final_mask[labels == i] = 1
            continue
            
        # Check if the component touches the image edge
        x, y, comp_w, comp_h, _ = stats[i]
        touches_edge = (x == 0) or (y == 0) or (x + comp_w == w) or (y + comp_h == h)
        
        # If it's a small edge sliver (< 20% of main object), discard it
        if touches_edge and (area < 0.2 * largest_area):
            continue
            
        # Keep internal disconnected parts or large edge objects
        final_mask[labels == i] = 1
        
    # Dilate the mask to ensure we don't cut off soft anti-aliased edge pixels of kept components
    kernel = np.ones((5,5), np.uint8)
    dilated_mask = cv2.dilate(final_mask, kernel, iterations=2)
    
    img_arr[:, :, 3] = img_arr[:, :, 3] * dilated_mask
    return Image.fromarray(img_arr)

def main():
    try:
        # Read the raw image bytes from stdin
        input_data = sys.stdin.buffer.read()
        if not input_data:
            sys.exit(1)
        
        # Load image via Pillow
        input_img = Image.open(io.BytesIO(input_data))
        
        # Remove the background using rembg
        output_img = remove(input_img)
        
        # Post-process to remove edge slivers (from adjacent objects)
        output_img = remove_edge_slivers(output_img)
        
        # Save mask to a buffer as PNG
        out_buffer = io.BytesIO()
        output_img.save(out_buffer, format="PNG")
        
        # Write the mask PNG bytes to stdout
        sys.stdout.buffer.write(out_buffer.getvalue())
        sys.exit(0)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
