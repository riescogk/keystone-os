"""Small read-only Compound File Binary (CFB/OLE2) reader; no external packages.
Only streams are exposed; no embedded objects are executed.
"""
from __future__ import annotations
import struct
from pathlib import Path

END = 0xFFFFFFFE
FREE = 0xFFFFFFFF

class OleError(ValueError): pass

class OleReader:
    def __init__(self, path: Path, max_bytes:int=120_000_000):
        self.path=Path(path)
        self.data=self.path.read_bytes()
        if len(self.data)>max_bytes:raise OleError('OLE file exceeds size limit')
        h=self.data[:512]
        if len(h)<512 or h[:8]!=bytes.fromhex('d0cf11e0a1b11ae1'):raise OleError('Not a valid OLE compound file')
        byte_order=struct.unpack_from('<H',h,0x1c)[0]
        if byte_order!=0xfffe:raise OleError('Invalid byte order')
        shift=struct.unpack_from('<H',h,0x1e)[0]
        mini_shift=struct.unpack_from('<H',h,0x20)[0]
        if shift not in (9,12) or mini_shift!=6:raise OleError('Unsupported OLE sector size')
        self.sector_size=1<<shift
        self.mini_size=1<<mini_shift
        self.max_sectors=max(0,(len(self.data)-self.sector_size)//self.sector_size)
        self.cutoff=struct.unpack_from('<I',h,0x38)[0]
        nfat,first_dir,nmini,first_mini,ndifat,first_difat=(struct.unpack_from('<I',h,0x2c)[0],struct.unpack_from('<I',h,0x30)[0],struct.unpack_from('<I',h,0x40)[0],struct.unpack_from('<I',h,0x3c)[0],struct.unpack_from('<I',h,0x48)[0],struct.unpack_from('<I',h,0x44)[0])
        difat=list(struct.unpack_from('<109I',h,0x4c))
        nxt=first_difat
        for _ in range(min(ndifat,self.max_sectors)):
            sec=self.sector(nxt)
            slots=self.sector_size//4-1
            difat.extend(struct.unpack_from(f'<{slots}I',sec,0))
            nxt=struct.unpack_from('<I',sec,slots*4)[0]
            if nxt in (END,FREE): break
        fatids=[x for x in difat if x<self.max_sectors][:nfat]
        self.fat=[]
        for n in fatids:
            s=self.sector(n)
            self.fat.extend(struct.unpack(f'<{self.sector_size//4}I',s))
        dir_data=self.read_chain(first_dir, None)
        self.entries=[]
        for off in range(0,len(dir_data)-127,128):
            item=dir_data[off:off+128]
            name_len=struct.unpack_from('<H',item,64)[0]
            if name_len<2 or name_len>64 or name_len%2: name=''
            else: name=item[:name_len-2].decode('utf-16le','replace')
            typ=item[66]
            start=struct.unpack_from('<I',item,116)[0]
            size=struct.unpack_from('<Q',item,120)[0]
            if shift==9: size=size&0xffffffff
            self.entries.append({'name':name,'type':typ,'start':start,'size':size})
        root=next((e for e in self.entries if e['type']==5),None)
        if root is None: raise OleError('Missing OLE root')
        self.mini_stream=self.read_chain(root['start'],root['size'])
        self.mini_fat=[]
        if first_mini!=END and nmini:
            mini_bytes=self.read_chain(first_mini,min(nmini*self.sector_size,len(self.data)))
            self.mini_fat=list(struct.unpack(f'<{len(mini_bytes)//4}I',mini_bytes[:len(mini_bytes)//4*4]))
    def sector(self,idx):
        if idx>=self.max_sectors or idx<0:raise OleError('OLE sector out of range')
        pos=self.sector_size+idx*self.sector_size
        return self.data[pos:pos+self.sector_size]
    def read_chain(self,start,size):
        if size==0:return b''
        result=bytearray(); seen=set();cur=start
        max_steps=((min(size,len(self.data)) if size is not None else min(len(self.data),8_000_000))+self.sector_size-1)//self.sector_size+1
        for _ in range(max_steps):
            if cur in (END,FREE):break
            if cur in seen or cur>=len(self.fat):
                # During directory initialization FAT exists, but no forgiving invalid chain.
                raise OleError('Invalid OLE FAT chain')
            seen.add(cur)
            result.extend(self.sector(cur))
            cur=self.fat[cur]
            if size is not None and len(result)>=size:break
        if size is not None and len(result)<size:raise OleError('Truncated OLE stream')
        return bytes(result if size is None else result[:size])
    def read_mini_chain(self,start,size):
        result=bytearray();seen=set();cur=start
        for _ in range((size+self.mini_size-1)//self.mini_size+1):
            if cur in (END,FREE):break
            if cur in seen or cur>=len(self.mini_fat):raise OleError('Invalid mini-FAT chain')
            seen.add(cur)
            pos=cur*self.mini_size
            result.extend(self.mini_stream[pos:pos+self.mini_size]);cur=self.mini_fat[cur]
            if len(result)>=size:break
        if len(result)<size:raise OleError('Truncated mini stream')
        return bytes(result[:size])
    def list_streams(self):
        return [(e['name'],e['size']) for e in self.entries if e['type']==2]
    def get(self,name):
        for e in self.entries:
            if e['type']==2 and e['name']==name:
                if e['size']>len(self.data)*2:raise OleError('Oversized stream')
                if e['size']<self.cutoff and self.mini_fat:
                    return self.read_mini_chain(e['start'],e['size'])
                return self.read_chain(e['start'],e['size'])
        raise KeyError(name)
