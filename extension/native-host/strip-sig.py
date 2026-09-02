# Strip Authenticode signature from a PE file (Windows SEA requirement).
# Removes the IMAGE_DIRECTORY_ENTRY_SECURITY (index 4) data directory so postject can inject the blob.
import sys

def strip_sig(path):
    with open(path, 'r+b') as f:
        data = bytearray(f.read())
    # DOS header: e_lfanew at offset 0x3C
    e_lfanew = int.from_bytes(data[0x3C:0x40], 'little')
    # PE signature at e_lfanew: 'PE\0\0'
    # COFF File Header starts at e_lfanew + 4, SizeOfOptionalHeader at +20
    opt_hdr_offset = e_lfanew + 4 + 20
    magic = int.from_bytes(data[opt_hdr_offset:opt_hdr_offset+2], 'little')
    coff_off = e_lfanew + 4
    opt_size = int.from_bytes(data[coff_off + 16:coff_off + 18], 'little')
    sec_table_off = opt_hdr_offset + opt_size
    # NumberOfRvaAndSizes 在 PE32+ 位于 opt_hdr_offset + 0x70，PE32 位于 + 0x74
    if magic == 0x10b:  # PE32
        num_rva_off = opt_hdr_offset + 0x74
        dd_off = opt_hdr_offset + 0x78
    else:  # PE32+
        num_rva_off = opt_hdr_offset + 0x70
        dd_off = opt_hdr_offset + 0x78
    num_rva = int.from_bytes(data[num_rva_off:num_rva_off+4], 'little')
    # Security directory is data directory index 4: dd_off + 4*8 = +32
    sec_off = dd_off + 4 * 8
    sec_va = int.from_bytes(data[sec_off:sec_off+4], 'little')
    sec_size = int.from_bytes(data[sec_off+4:sec_off+8], 'little')
    if sec_va == 0 and sec_size == 0:
        print('no signature present, skip')
        return
    # Parse section table to find the end of the last section (raw data on disk).
    num_sec_off = e_lfanew + 4 + 2
    num_sections = int.from_bytes(data[num_sec_off:num_sec_off+2], 'little')
    sec_table_off = opt_hdr_offset + opt_size
    last_end = 0
    for s in range(num_sections):
        so = sec_table_off + s * 40
        ptr_raw = int.from_bytes(data[so+20:so+24], 'little')   # PointerToRawData
        sz_raw = int.from_bytes(data[so+16:so+20], 'little')    # SizeOfRawData
        if ptr_raw and sz_raw:
            end = ptr_raw + sz_raw
            if end > last_end:
                last_end = end
    if last_end == 0:
        # fallback: truncate to file size - signature size
        last_end = len(data) - sec_size
    new_len = last_end
    if new_len > 0 and new_len < len(data):
        data = data[:new_len]
    # Zero out the security directory entry
    data[sec_off:sec_off+8] = b'\x00' * 8
    with open(path, 'wb') as f:
        f.write(data)
    print(f'removed signature blob: va={sec_va} size={sec_size} new_len={new_len}')

if __name__ == '__main__':
    strip_sig(sys.argv[1])
