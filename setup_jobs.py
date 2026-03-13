import json
import math
import os

def calculate_chunks(text_file):
    if not os.path.exists(text_file):
        print(json.dumps([0]))
        return
        
    with open(text_file, 'r', encoding='utf-8') as f:
        text = f.read()
    
    total_chars = len(text)
    chunk_size = 500
    
    # Calculate jobs
    total_jobs = math.ceil(total_chars / chunk_size)
    if total_jobs == 0: total_jobs = 1
    
    job_indices = list(range(total_jobs))
    print(json.dumps(job_indices))

if __name__ == "__main__":
    calculate_chunks('input.txt')
