// max-work program shapes (work = 127 each, just under the cap of 128), built from the real op set
const op=(c,d=0,a=0,b=0)=>[c,d,a,b]; const prog=ops=>Buffer.from([1,ops.length,0,0,...ops.flat()]); const POS=r=>op(31,0,r,0);
export const SHAPES={
 "2xZW(31)":prog([op(26,0,31),op(26,1,31),POS(1)]),
 "3xWSUM(32)+27xADD":prog([op(24,0,32),op(24,1,32),op(24,2,32),...Array.from({length:27},(_,i)=>op(4,3+(i%10),i%3,(i+1)%3)),POS(0)]),
 "31xDIV+2xADD":prog([...Array.from({length:31},(_,i)=>op(7,3+(i%10),0,1)),op(4,3,0,1),op(4,4,0,1),POS(0)]),
 "63xMUL":prog([...Array.from({length:63},(_,i)=>op(6,3+(i%10),(i%3),(i+1)%3)),POS(0)]),
 "63xHIST":prog([...Array.from({length:63},(_,i)=>op(23,3+(i%10),i%32,0)),POS(3)]),
 "3xVOLW(32)+27xADD":prog([op(25,0,32),op(25,1,32),op(25,2,32),...Array.from({length:27},(_,i)=>op(4,3+(i%10),i%3,(i+1)%3)),POS(0)]),
};
