import asyncio
import motor.motor_asyncio
import bcrypt

def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()

async def main():
    client = motor.motor_asyncio.AsyncIOMotorClient('mongodb://localhost:27017')
    db = client['accessguard']
    
    user = await db.invigilators.find_one({'inv_id': 'EG/STAFF/0001'})
    if not user:
        await db.invigilators.insert_one({
            "inv_id": "EG/STAFF/0001",
            "name": "Test Invigilator",
            "password_hash": hash_pw("AccessGuard2026!"),
            "phone": "+15550101",
        })
        print('User EG/STAFF/0001 inserted.')
    else:
        await db.invigilators.update_one(
            {'inv_id': 'EG/STAFF/0001'},
            {'$set': {'password_hash': hash_pw("AccessGuard2026!")}}
        )
        print('User EG/STAFF/0001 updated.')
    
    client.close()

if __name__ == "__main__":
    asyncio.run(main())
