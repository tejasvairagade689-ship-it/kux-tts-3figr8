import json
import os
import math

def calculate_chunks(text_file):
    if not os.path.exists(text_file):
        # Create a default input file if it doesn't exist for testing
        with open(text_file, 'w', encoding='utf-8') as f:
            f.write("Bhai, ye ek default test text hai Kyutai TTS ke liye.")
    
    with open(text_file, 'r', encoding='utf-8') as f:
        text = f.read()
    
    total_chars = len(text)
    chunk_size = 500
    
    # Calculate total jobs needed
    total_jobs = math.ceil(total_chars / chunk_size)
    if total_jobs == 0: total_jobs = 1
    
    # Ek list banate hain [0, 1, 2, ..., n-1]
    job_indices = list(range(total_jobs))
    
    # GitHub Actions ko JSON format mein bhejte hain
    print(json.dumps(job_indices))

if __name__ == "__main__":
    calculate_chunks('input.txt')
