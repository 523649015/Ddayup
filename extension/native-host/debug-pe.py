import sys
path = sys.argv[1]
with open(path, 'rb') as f:
    data = f.read()
print('file size:', len(data))
e_lfanew = int.from_bytes(data[0x3C:0x40], 'little')
opt_hdr_offset = e_lfanew + 4 + 20
magic = int.from_bytes(data[opt_hdr_offset:opt_hdr_offset+2], 'little')
coff_off = e_lfanew + 4
opt_size = int.from_bytes(data[coff_off + 16:coff_off + 18], 'little')
num_sec_off = e_lfanew + 4 + 2
num_sections = int.from_bytes(data[num_sec_off:num_sec_off+2], 'little')
sec_table_off = opt_hdr_offset + opt_size
print('opt_hdr_offset:', opt_hdr_offset, 'opt_size:', opt_size, 'sec_table_off:', sec_table_off, 'num_sections:', num_sections)
last_end = 0
for s in range(num_sections):
    so = sec_table_off + s * 40
    name = data[so:so+8].split(b'\x00')[0].decode('latin1', 'replace')
    va = int.from_bytes(data[so+12:so+16], 'little')
    sz_raw = int.from_bytes(data[so+16:so+20], 'little')
    ptr_raw = int.from_bytes(data[so+20:so+24], 'little')
    end = ptr_raw + sz_raw
    print(f'  sec[{s}] {name:8} va={va} sz_raw={sz_raw} ptr_raw={ptr_raw} end={end}')
    if ptr_raw and sz_raw and end > last_end:
        last_end = end
print('last section end:', last_end)
