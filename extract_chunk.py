import sys
import os

def extract():
    if len(sys.argv) < 2:
        return
    
    chunk_id = int(sys.argv[1])
    chunk_size = 500
    text_file = 'input.txt'

    if not os.path.exists(text_file):
        return

    with open(text_file, 'r', encoding='utf-8') as f:
        text = f.read()

    start = chunk_id * chunk_size
    end = start + chunk_size
    chunk = text[start:end]

    # Print to stdout so bash can capture it
    sys.stdout.write(chunk)

if __name__ == "__main__":
    extract()
