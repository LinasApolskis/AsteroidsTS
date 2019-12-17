import {Socket} from "socket.io"
import {AsteroidDTO, BulletDTO, GameDataDTO, PlayerDTO, PlayerInputDTO, PowerUpDTO} from "../shared/DTOs"
import {RGBColor} from "react-color"
import {Constants} from "../shared/Constants"
import Utils from "../shared/Utils"
import Victor = require("victor")
import uuid = require("uuid")

export interface DomainSocket extends Socket {
    me: ServerPlayer | null
}

export interface GameEventsHandler {
    bulletKilledPlayer(bullet: ServerBullet, player: ServerPlayer): void
    bulletKilledAsteroid(bullet: ServerBullet, asteroid: ServerAsteroid|ServerAsteroidSmall|ServerAsteroidBig): void
    bulletKilledPowerup(bullet: ServerBullet, powerUp: PowerUp): void
    powerupKilledPlayer(powerUp: PowerUp, player: ServerPlayer): void
    asteroidKilledPlayer(asteroid: ServerAsteroid|ServerAsteroidSmall|ServerAsteroidBig, player: ServerPlayer): void
}

export interface CollidingObject {
    x: number
    y: number
    vertices: number[][]
    minCollidingDistance: number
    maxCollidingDistance: number
    checkCollidedWith(...othersArray: CollidingObject[][]): void
    isCollisionTarget(other: CollidingObject): boolean
    processCollidedWith(other: CollidingObject): void
}


export class ServerGameData {
    // canvas width & height fixed to 4000
    private readonly width: number = 4000
    private readonly height: number = 4000

    private readonly players: Map<string, ServerPlayer> = new Map()
    // todo: change list to map for faster add/remove/query
    private readonly bulletHouse: BulletHouse = new BulletHouse()
    private readonly asteroids: (ServerAsteroid|ServerAsteroidBig|ServerAsteroidSmall|IServerAsteroid)[] = []
    private readonly powerups: PowerUp[] = []

    private readonly minBigAsteroidCount = 7
    private readonly bigAsteroidCountMultiplesOfPlayer = 3
    private curBigAsteroidsCount = 0
    private readonly minPowerUpsCount = 7
    private curPowerUpsCount = 0

    // DTO object (i.e. saturated data for sending over internet) of this object
    // keeps sync with this object in update() function
    readonly dtoObject: GameDataDTO

    private readonly gameEventsHandler: GameEventsHandler

    constructor(gameEventsHandler: GameEventsHandler) {
        const w = this.width
        const h = this.height

        // Factory pattern
        const asteroidBigFactory = new AsteroidBigFactory(gameEventsHandler)
        const asteroidBaseFactory = new AsteroiBaseFactory(gameEventsHandler)
        const asteroidSmallFactory = new AsteroidSmallFactory(gameEventsHandler)


        //Builder pattern
        const asteroidBuilder = new AsteroidBuilder(gameEventsHandler)

        //asteroidBuilder->set

        // add initial asteroids
        const asteroidas = new ServerAsteroid(w, h, 2, gameEventsHandler)

        for (let i = 0; i < this.minBigAsteroidCount; i++) {
            //this.asteroids.push(new ServerAsteroid(w, h, 2, gameEventsHandler))
            this.asteroids.push(asteroidas.clone())
            this.asteroids.push(asteroidBigFactory.CreateAsteroid())
            this.asteroids.push(asteroidSmallFactory.CreateAsteroid())
            this.asteroids.push(asteroidBaseFactory.CreateAsteroid())
            this.curBigAsteroidsCount++
        }

        for (let i = 0; i < this.minPowerUpsCount; i++) {
            this.powerups.push(new PowerUp(4000, 4000, gameEventsHandler))
            this.curPowerUpsCount++
        }

        this.dtoObject = {
            width: this.width,
            height: this.height,
            players: Array.from(this.players.values()).map(value => value.dtoObject),
            bullets: this.bulletHouse.bullets.map(bullet => bullet.dtoObject),
            asteroids: this.asteroids.map(value => value.dtoObject),
            powerups: this.powerups.map(value => value.dtoObject)
        }

        this.gameEventsHandler = gameEventsHandler
    }

    update(): void {
        const width = this.width
        const height = this.height
        const players = this.players
        const bulletHouse = this.bulletHouse
        const asteroids = this.asteroids
        const powerups = this.powerups

        // update position, color etc of all child data
        players.forEach(player => player.update(width, height))
        bulletHouse.update(width, height)

        for (let i = 0; i < asteroids.length; i++) {
            const asteroid = asteroids[i]
            asteroid.update(width, height)
            if (asteroid.needNewTarget) {
                if (asteroid.isBig) {
                    const randPlayer = Utils.pickRandom(Array.from(this.players.values()))
                    if (randPlayer) {
                        asteroid.setTarget(randPlayer.x, randPlayer.y)
                    } else {
                        asteroid.setTarget(Utils.randInt(0, width), Utils.randInt(0, height))
                    }
                } else {
                    asteroids.splice(i--, 1)
                }
            }
        }

        for (let i = 0; i < powerups.length; i++) {
            const powerup = powerups[i]
            powerup.update(width, height)
        }

        // do collision detection
        // may invoke GameEventsHandler functions when collisions are detected
        const bullets = bulletHouse.bullets
        let i = asteroids.length
        while (i--) {
            asteroids[i].checkCollidedWith(bullets)
        }

        let k = powerups.length
        while (k--) {
            powerups[k].checkCollidedWith(bullets)
        }

        players.forEach(player => player.checkCollidedWith(asteroids, bullets, powerups))

        // big asteroids may have been reduced in size due to above collision processing.
        // add some more if necessary
        const neededBigAsteroidCount = Math.max(this.minBigAsteroidCount, players.size * this.bigAsteroidCountMultiplesOfPlayer)
        if (this.curBigAsteroidsCount < neededBigAsteroidCount) {
            const count = neededBigAsteroidCount - this.curBigAsteroidsCount
            const gameEventsHandler = this.gameEventsHandler
            for (let i = 0; i < count; i++) {
                asteroids.push(new ServerAsteroid(width, height, 2, gameEventsHandler))
                this.curBigAsteroidsCount++
            }
        }

        // sync dtoObject
        const dto = this.dtoObject
        dto.players = Array.from(this.players.values()).map(value => value.dtoObject)
        dto.bullets = this.bulletHouse.bullets.map(bullet => bullet.dtoObject)
        dto.asteroids = this.asteroids.map(value => value.dtoObject)
        dto.powerups = this.powerups.map(value => value.dtoObject)
    }

    addPlayer(id: string, name: string, color: RGBColor): ServerPlayer {
        const newPlayer = new ServerPlayer(id, name, color, this.width / 2, this.height / 2,
            this.bulletHouse, this.gameEventsHandler)
        this.players.set(id, newPlayer)
        return newPlayer
    }

    removePlayerById(id: string): ServerPlayer | null {
        const player = this.players.get(id)
        if (player) {
            this.players.delete(id)
            return player
        } else {
            return null
        }
    }

    breakAsteroid(asteroid: ServerAsteroid | ServerAsteroidSmall | ServerAsteroidBig | IServerAsteroid): void {
        const removed = this.removeAsteroidById(asteroid.id)
        // if broken asteroid was a big one, create 3 little pieces from its location
        // else, just remove it and done
        if (removed && removed.isBig == 3) {
            const width = this.width
            const height = this.height

            this.asteroids.push(
                ServerAsteroidBig.createPieceOf(width, height, removed),
                ServerAsteroidBig.createPieceOf(width, height, removed),
                ServerAsteroidBig.createPieceOf(width, height, removed),
                ServerAsteroidBig.createPieceOf(width, height, removed),
                ServerAsteroidBig.createPieceOf(width, height, removed),
                ServerAsteroidBig.createPieceOf(width, height, removed),
            )
            this.curBigAsteroidsCount--
        }
        if (removed && removed.isBig == 2) {
            const width = this.width
            const height = this.height

            this.asteroids.push(
                ServerAsteroidSmall.createPieceOf(width, height, removed),
                ServerAsteroidSmall.createPieceOf(width, height, removed),
                ServerAsteroidSmall.createPieceOf(width, height, removed),
            )
            this.curBigAsteroidsCount--
        }
    }

    breakPowerUp(powerUp: PowerUp): void {
        const removed = this.removePowerUpById(powerUp.id)
        this.curPowerUpsCount--
    }

    private removeAsteroidById(id: string): ServerAsteroid | ServerAsteroidSmall | ServerAsteroidBig | IServerAsteroid | null {
        const asteroids = this.asteroids
        const index = asteroids.findIndex(value => id === value.id)
        if (index >= 0) {
            const removing = asteroids[index]
            asteroids.splice(index, 1)
            return removing
        } else {
            return null
        }
    }

    private removePowerUpById(id: string): PowerUp | null {
        const powerups = this.powerups
        const index = powerups.findIndex(value => id === value.id)
        if (index >= 0) {
            const removing = powerups[index]
            powerups.splice(index, 1)
            return removing
        } else {
            return null
        }
    }

    getPlayerWithId(id: string): ServerPlayer | null {
        return this.players.get(id) || null
    }

    recycleBulletById(id: string): void {
        this.bulletHouse.recycleBulletById(id)
    }

    recycleBulletsByFirerId(firerId: string): void {
        this.bulletHouse.recycleBulletsByFirerId(firerId)
    }
}

export class ServerPlayer implements CollidingObject {
    private static readonly maxSpeed = 8

    readonly id: string
    private readonly name: string
    private readonly origColor: RGBColor
    private readonly currentColor: RGBColor
    private readonly size: number = 15
    x: number
    y: number
    private heading: number = Constants.HALF_PI
    readonly vertices: number[][] = []
    private showTail: boolean = false

    private readonly velocity = new Victor(0, 0)
    private readonly acceleration = new Victor(0, 0)
    private readonly boostingForce = new Victor(0, 0)
    private rotation = 0
    private isBoosting = false

    private isFiring = false
    private fireInterval = 1000 / 4
    private now = 0
    private then = Date.now()
    private fireDelta = 0

    private readonly bulletHouse: BulletHouse

    readonly dtoObject: PlayerDTO

    private readonly gameEventsHandler: GameEventsHandler

    // manually calculated from its fixed size (i.e. 15)
    readonly maxCollidingDistance: number = 21.21
    readonly minCollidingDistance: number = 6.7

    private asteroidPoints = 0
    private killingPoints = 0

    // when this player is created, it is invincible for this amount of frames
    private invincibleCountdown = 255

    private state: State;

    get isInvincible(): boolean {
        return this.invincibleCountdown > 0
    }

    constructor(id: string, name: string, color: RGBColor, x: number, y: number,
                bulletHouse: BulletHouse, gameEventsHandler: GameEventsHandler) {
        this.id = id
        this.name = name
        this.origColor = { r: color.r, g: color.g, b: color.b }
        this.currentColor = color
        this.x = x
        this.y = y

        const size = this.size
        this.vertices.push([-size, size], [size, size], [0, -size])

        this.bulletHouse = bulletHouse

        this.dtoObject = {
            id: this.id,
            name: this.name,
            color: this.currentColor,
            x: this.x,
            y: this.y,
            size: this.size,
            heading: this.heading,
            vertices: this.vertices,
            showTail: this.showTail,
            asteroidPoints: this.asteroidPoints,
            killingPoints: this.killingPoints
        }

        this.gameEventsHandler = gameEventsHandler
        this.state = new ConcreteStateA();
    }

    public transitionTo(state: State): void {
        console.log(`Context: Transition to ${(<any>state).constructor.name}.`);
        this.state = state;
        this.state.setContext(this);
    }

    public request1(): void {
        this.state.handle1();
    }

    public request2(): void {
        this.state.handle2();
    }

    applyInput(input: PlayerInputDTO): void {
        this.isBoosting = input.up

        if (input.left) {
            this.rotation = -0.08
        } else if (input.right) {
            this.rotation = 0.08
        } else if (!input.left && !input.right) {
            this.rotation = 0
        }

        this.isFiring = input.fire
    }

    update(width: number, height: number): void {
        this.heading += this.rotation

        // update x and y position
        this.updateBoostingForce(this.isBoosting)
        this.acceleration.add(this.boostingForce)
        this.velocity.add(this.acceleration)
        if (this.velocity.magnitude() > ServerPlayer.maxSpeed) {
            this.velocity.norm().multiplyScalar(ServerPlayer.maxSpeed)
        }
        this.velocity.multiplyScalar(0.99)
        this.x += this.velocity.x
        this.y += this.velocity.y

        this.checkEdges(width, height)

        this.acceleration.multiplyScalar(0)

        if (this.isFiring) {
            this.now = Date.now()
            this.fireDelta = this.now - this.then
            if (this.fireDelta > this.fireInterval) {
                this.then = this.now

                this.bulletHouse.fireBullet(this.id, this.x, this.y, this.heading, this.origColor)
            }
        }

        this.showTail = this.velocity.magnitude() > 1

        if (this.invincibleCountdown > 0) {
            this.invincibleCountdown -= 1
        }

        // update its color
        // when it's invincible, it will blink. else, it just shows its original color
        const origColor = this.origColor
        if (this.invincibleCountdown > 0) {
            const countdown = this.invincibleCountdown
            this.currentColor.r = Utils.randInt(Utils.map(countdown, 0, 255, origColor.r, 0), origColor.r)
            this.currentColor.g = Utils.randInt(Utils.map(countdown, 0, 255, origColor.g, 0), origColor.g)
            this.currentColor.b = Utils.randInt(Utils.map(countdown, 0, 255, origColor.b, 0), origColor.b)
        } else {
            this.transitionTo(new ConcreteStateA());
            this.state.handle1();
            this.currentColor.r = origColor.r
            this.currentColor.g = origColor.g
            this.currentColor.b = origColor.b
        }

        // update dtoObject
        const dto = this.dtoObject
        dto.x = this.x
        dto.y = this.y
        dto.heading = this.heading
        dto.showTail = this.showTail
        dto.color = this.currentColor
        dto.asteroidPoints = this.asteroidPoints
        dto.killingPoints = this.killingPoints
    }

    private updateBoostingForce(isBoosting: boolean): void {
        if (isBoosting) {
            this.boostingForce.addScalar(1).rotateBy(this.heading + Constants.HALF_PI).normalize().multiplyScalar(0.1)
        } else {
            this.boostingForce.multiplyScalar(0)
        }
    }

    // if it's outside screen, make it appear on the other side of the screen
    private checkEdges(width: number, height: number): void {
        const r = this.size

        if (this.x > width + r) {
            this.x = -r
        } else if (this.x < -r) {
            this.x = width + r
        }

        if (this.y > height + r) {
            this.y = -r
        } else if (this.y < -r) {
            this.y = height + r
        }
    }

    checkCollidedWith(...othersArray: CollidingObject[][]): void {
        // if it's invincible, it does not collide with anything
        if (this.isInvincible) {
            return
        }

        Utils.checkCollidedWith(this, othersArray)
    }

    isCollisionTarget(other: CollidingObject): boolean {
        if (other instanceof ServerBullet && other.firerId !== this.id && !other.needsToBeRecycled) {
            return true
        } else if (other instanceof ServerAsteroid || other instanceof ServerAsteroidBig || other instanceof ServerAsteroidSmall) {
            return true
        } else if (other instanceof PowerUp) {
            return true
        }
        return false
    }

    processCollidedWith(other: CollidingObject): void {
        if (other instanceof ServerBullet) {
            this.gameEventsHandler.bulletKilledPlayer(<ServerBullet>other, this)
        } else if (other instanceof ServerAsteroid || other instanceof ServerAsteroidBig || other instanceof ServerAsteroidSmall) {
            this.gameEventsHandler.asteroidKilledPlayer(<ServerAsteroid | ServerAsteroidSmall | ServerAsteroidBig | IServerAsteroid>other, this)
        } else if (other instanceof PowerUp) {
            this.gameEventsHandler.powerupKilledPlayer(<PowerUp>other, this)
            this.transitionTo(new ConcreteStateB());
            this.state.handle1();
        }
    }

    increaseAsteroidPoint(): void {
        this.asteroidPoints++
    }

    increaseKillingPoint(): void {
        this.killingPoints++
    }

    increaseInvinciblity(): void {
        this.invincibleCountdown += 255;
    }

    setRate(rate: number): void {
        this.fireInterval = rate;
    }
}
abstract class State {
    protected context: ServerPlayer|null = null;

    public setContext(context: ServerPlayer) {
        this.context = context;
    }

    public abstract handle1(): void;

    public abstract handle2(): void;
}

class ConcreteStateA extends State {
    public handle1(): void {
        // @ts-ignore
        //this.context.transitionTo(new ConcreteStateB());
        // @ts-ignore
        this.context.setRate(250);
    }

    public handle2(): void {
    }
}

class ConcreteStateB extends State {
    public handle1(): void {
        // @ts-ignore
        //this.context.transitionTo(new ConcreteStateA());
        // @ts-ignore
        this.context.setRate(0.1);
        // @ts-ignore
        this.context.increaseInvinciblity();
        // @ts-ignore
        this.context.increaseInvinciblity();
    }

    public handle2(): void {

    }
}

// keep track of bullets onscreen and bullets offscreen (i.e. recycled bullets) to reuse bullet instances
class BulletHouse {
    // recycledBullets are offscreen bullets
    private readonly recycledBullets: ServerBullet[] = []
    readonly bullets: ServerBullet[] = []

    fireBullet(firerId: string, x: number, y: number, heading: number, color: RGBColor): void {
        const bullet = this.createOrGetBullet()
        bullet.setInitValues(firerId, x, y, heading, color)
        this.bullets.push(bullet)
    }

    private createOrGetBullet(): ServerBullet {
        let bullet = this.recycledBullets.pop()
        if (!bullet) {
            bullet = new ServerBullet()
        }
        return bullet
    }

    update(width: number, height: number): void {
        const bullets = this.bullets
        const recycledBullets = this.recycledBullets
        let i = bullets.length
        while (i--) {
            const bullet = bullets[i]
            // update position of onscreen bullets
            bullet.update(width, height)

            // if bullet went offscreen, recycle it
            if (bullet.needsToBeRecycled) {
                bullet.prepareRecycle()
                recycledBullets.push(bullet)
                bullets.splice(i, 1)
            }
        }
    }

    recycleBulletById(id: string): void {
        const index = this.bullets.findIndex(bullet => bullet.id === id)
        if (index >= 0) {
            const b = this.bullets[index]
            b.prepareRecycle()
            this.recycledBullets.push(b)
            this.bullets.splice(index, 1)
        }
    }

    recycleBulletsByFirerId(firerId: string): void {
        const bullets = this.bullets
        const recycled = this.recycledBullets

        let i = bullets.length
        while (i--) {
            const bullet = bullets[i]
            if (bullet.firerId === firerId) {
                bullet.prepareRecycle()
                recycled.push(bullet)
                bullets.splice(i, 1)
            }
        }
    }

}

export class ServerBullet implements CollidingObject {
    private static readonly speed = 10

    readonly id: string = uuid()
    private readonly size: number = 5
    readonly vertices: number[][] = [[0, -this.size], [0, this.size]]
    x: number = 0
    y: number = 0
    private heading: number = 0

    firerId: string | null = null
    private readonly velocity = new Victor(0, 0)
    private color = { r: 255, g: 255, b: 255 }

    needsToBeRecycled = false

    readonly dtoObject: BulletDTO = {
        id: this.id,
        x: this.x,
        y: this.y,
        heading: this.heading,
        vertices: this.vertices,
        color: this.color
    }

    readonly maxCollidingDistance: number = this.size
    readonly minCollidingDistance: number = 0

    setInitValues(firerId: string, x: number, y: number, heading: number, color: RGBColor): void {
        this.firerId = firerId
        this.x = x
        this.y = y
        this.heading = heading
        this.velocity.addScalar(1).rotateBy(heading + Constants.HALF_PI).norm().multiplyScalar(ServerBullet.speed)
        this.color = color
    }

    update(width: number, height: number): void {
        this.x += this.velocity.x
        this.y += this.velocity.y

        const x = this.x
        const y = this.y
        if (!this.needsToBeRecycled) {
            this.needsToBeRecycled = x > width || x < 0 || y > height || y < 0
        }

        // update dtoObject
        const dto = this.dtoObject
        dto.x = x
        dto.y = y
        dto.heading = this.heading
        dto.color = this.color
    }

    prepareRecycle(): void {
        // send it to wonderland
        this.x = -1000
        this.y = -1000
        this.heading = 0
        this.velocity.multiplyScalar(0)
        this.firerId = null
        this.needsToBeRecycled = false
    }

    // bullet itself does not check collision.
    // other objects check collision with bullets
    checkCollidedWith(...othersArray: CollidingObject[][]): void {
        // no need to implement
    }

    isCollisionTarget(other: CollidingObject): boolean {
        // no need to implement
        return false;
    }

    processCollidedWith(other: CollidingObject): void {
        // no need to implement
    }

}

export class ServerAsteroidBig implements CollidingObject, IServerAsteroid {
    static readonly bigAsteroidVertexCount = 10
    static readonly smallAsteroidVertexCount = 5

    readonly id: string = uuid()
    readonly maxCollidingDistance: number
    readonly minCollidingDistance: number
    readonly vertices: number[][] = []
    x!: number
    y!: number
    rotation: number = 0
    readonly rotationSpeed: number
    readonly velocity = new Victor(0, 0)
    speed: number

    color: RGBColor

    needNewTarget = true

    readonly outsideThreshold: number = 50

    readonly isBig: number

    readonly dtoObject: AsteroidDTO

    readonly gameEventsHandler: GameEventsHandler

    health: number = 3

    static createPieceOf(width: number, height: number, bigAsteroid: ServerAsteroid | ServerAsteroidSmall | ServerAsteroidBig | IServerAsteroid): ServerAsteroid | ServerAsteroidSmall | ServerAsteroidBig | IServerAsteroid {
        const asteroid = new ServerAsteroid(width, height, 2, bigAsteroid.gameEventsHandler)
        asteroid.x = bigAsteroid.x + Utils.map(Math.random(), 0, 1, -20, 20)
        asteroid.y = bigAsteroid.y + Utils.map(Math.random(), 0, 1, -20, 20)
        asteroid.needNewTarget = false
        asteroid.velocity.x = Utils.map(Math.random(), 0, 1, -1, 1)
        asteroid.velocity.y = Utils.map(Math.random(), 0, 1, -1, 1)
        asteroid.velocity.norm().multiplyScalar(asteroid.speed)
        return asteroid
    }

    constructor(width: number, height: number, isBig: number, gameEventsHandler: GameEventsHandler, health:number = 3, color:RGBColor = { r: 255, g: 255, b: 0 }) {
        this.setRandomSpawnPoint(width, height)
        this.isBig = isBig


            this.rotationSpeed = Utils.map(Math.random(), 0, 1, 0.01, 0.03)
            this.speed = Utils.map(Math.random(), 0, 1, 1, 2)
            this.maxCollidingDistance = Utils.randInt(100, 120)
            this.minCollidingDistance = Utils.randInt(60, 80)
            this.color = color

            const vertexCount = ServerAsteroidBig.bigAsteroidVertexCount
            for (let i = 0; i < vertexCount; i++) {
                const angle = Utils.map(i, 0, vertexCount, 0, Constants.TWO_PI)
                const r = Utils.randInt(this.minCollidingDistance, this.maxCollidingDistance)
                const x = r * Math.cos(angle)
                const y = r * Math.sin(angle)
                this.vertices.push([x, y])
            }

        this.dtoObject = {
            id: this.id,
            x: this.x,
            y: this.y,
            rotation: this.rotation,
            vertices: this.vertices,
            color: this.color,
            health: this.health
        }

        this.gameEventsHandler = gameEventsHandler
    }

    setTarget(x: number, y: number): void {
        // small asteroid is a little faster than big one
        if (this.isBig) {
            this.speed = Utils.map(Math.random(), 0, 1, 1, 2)
        } else {
            this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
        }
        const v = new Victor(x, y).subtractScalarX(this.x).subtractScalarY(this.y).norm().multiplyScalar(this.speed)
        this.velocity.x = v.x
        this.velocity.y = v.y
        this.needNewTarget = false
    }

    setRandomSpawnPoint(width: number, height: number) {
        const rand = Math.random()
        if (rand < 0.25) {
            this.x = Utils.randInt(-200, -100)
            this.y = Utils.randInt(0, height)
        } else if (rand < 0.5) {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(-200, -100)
        } else if (rand < 0.75) {
            this.x = Utils.randInt(width + 100, width + 200)
            this.y = Utils.randInt(0, height)
        } else {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(height + 100, height + 200)
        }
    }

    update(width: number, height: number): void {
        this.rotation += this.rotationSpeed
        this.x += this.velocity.x
        this.y += this.velocity.y

        const x = this.x
        const y = this.y
        const size = this.maxCollidingDistance
        const outsideThreshold = this.outsideThreshold

        if (!this.needNewTarget) {
            this.needNewTarget = x - size > width + outsideThreshold || x + size < -outsideThreshold
                || y - size > height + outsideThreshold || y + size < -outsideThreshold
        }

        // update dtoObject
        const dto = this.dtoObject
        dto.x = x
        dto.y = y
        dto.rotation = this.rotation
    }

    checkCollidedWith(...othersArray: CollidingObject[][]): void {
        Utils.checkCollidedWith(this, othersArray)
    }

    isCollisionTarget(other: CollidingObject): boolean {
        if (other instanceof ServerBullet && !other.needsToBeRecycled) {
            return true
        }
        return false
    }

    processCollidedWith(other: CollidingObject): void {
        if (other instanceof ServerBullet) {
            this.gameEventsHandler.bulletKilledAsteroid(<ServerBullet>other, this)
        }
    }

    public clone(): this {
        const clone = Object.create(this);
        return clone;
    }

}

export class ServerAsteroidSmall implements CollidingObject, IServerAsteroid {
    static readonly bigAsteroidVertexCount = 10
    static readonly smallAsteroidVertexCount = 5

    readonly id: string = uuid()
    readonly maxCollidingDistance: number
    readonly minCollidingDistance: number
    readonly vertices: number[][] = []
    x!: number
    y!: number
    rotation: number = 0
    readonly rotationSpeed: number
    readonly velocity = new Victor(0, 0)
    speed: number

    color: RGBColor

    needNewTarget = true

    readonly outsideThreshold: number = 50

    readonly isBig: number

    readonly dtoObject: AsteroidDTO

    readonly gameEventsHandler: GameEventsHandler

    readonly health = 1

    static createPieceOf(width: number, height: number, bigAsteroid: ServerAsteroid|ServerAsteroidBig|ServerAsteroidSmall|IServerAsteroid): ServerAsteroid|ServerAsteroidBig|ServerAsteroidSmall|IServerAsteroid {
        const asteroid = new ServerAsteroidSmall(width, height, 0, bigAsteroid.gameEventsHandler)
        asteroid.x = bigAsteroid.x + Utils.map(Math.random(), 0, 1, -20, 20)
        asteroid.y = bigAsteroid.y + Utils.map(Math.random(), 0, 1, -20, 20)
        asteroid.needNewTarget = false
        asteroid.velocity.x = Utils.map(Math.random(), 0, 1, -1, 1)
        asteroid.velocity.y = Utils.map(Math.random(), 0, 1, -1, 1)
        asteroid.velocity.norm().multiplyScalar(asteroid.speed)
        return asteroid
    }

    constructor(width: number, height: number, isBig: number, gameEventsHandler: GameEventsHandler, health:number = 1, color:RGBColor = { r: 255, g: 0, b: 0 }) {
        this.setRandomSpawnPoint(width, height)
        this.isBig = isBig

            this.rotationSpeed = Utils.map(Math.random(), 0, 1, 0.05, 0.07)
            this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
            this.maxCollidingDistance = Utils.randInt(40, 60)
            this.minCollidingDistance = Utils.randInt(10, 30)
            this.color = color

            const vertexCount = ServerAsteroidSmall.smallAsteroidVertexCount
            for (let i = 0; i < vertexCount; i++) {
                const angle = Utils.map(i, 0, vertexCount, 0, Constants.TWO_PI)
                const r = Utils.randInt(this.minCollidingDistance, this.maxCollidingDistance)
                const x = r * Math.cos(angle)
                const y = r * Math.sin(angle)
                this.vertices.push([x, y])
            }


        this.dtoObject = {
            id: this.id,
            x: this.x,
            y: this.y,
            rotation: this.rotation,
            vertices: this.vertices,
            color: this.color,
            health: this.health
        }

        this.gameEventsHandler = gameEventsHandler
    }

    setTarget(x: number, y: number): void {
        // small asteroid is a little faster than big one
        if (this.isBig) {
            this.speed = Utils.map(Math.random(), 0, 1, 1, 2)
        } else {
            this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
        }
        const v = new Victor(x, y).subtractScalarX(this.x).subtractScalarY(this.y).norm().multiplyScalar(this.speed)
        this.velocity.x = v.x
        this.velocity.y = v.y
        this.needNewTarget = false
    }

    setRandomSpawnPoint(width: number, height: number) {
        const rand = Math.random()
        if (rand < 0.25) {
            this.x = Utils.randInt(-200, -100)
            this.y = Utils.randInt(0, height)
        } else if (rand < 0.5) {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(-200, -100)
        } else if (rand < 0.75) {
            this.x = Utils.randInt(width + 100, width + 200)
            this.y = Utils.randInt(0, height)
        } else {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(height + 100, height + 200)
        }
    }

    update(width: number, height: number): void {
        this.rotation += this.rotationSpeed
        this.x += this.velocity.x
        this.y += this.velocity.y

        const x = this.x
        const y = this.y
        const size = this.maxCollidingDistance
        const outsideThreshold = this.outsideThreshold

        if (!this.needNewTarget) {
            this.needNewTarget = x - size > width + outsideThreshold || x + size < -outsideThreshold
                || y - size > height + outsideThreshold || y + size < -outsideThreshold
        }

        // update dtoObject
        const dto = this.dtoObject
        dto.x = x
        dto.y = y
        dto.rotation = this.rotation
    }

    checkCollidedWith(...othersArray: CollidingObject[][]): void {
        Utils.checkCollidedWith(this, othersArray)
    }

    isCollisionTarget(other: CollidingObject): boolean {
        if (other instanceof ServerBullet && !other.needsToBeRecycled) {
            return true
        }
        return false
    }

    processCollidedWith(other: CollidingObject): void {
        if (other instanceof ServerBullet) {
            this.gameEventsHandler.bulletKilledAsteroid(<ServerBullet>other, this)
        }
    }

    public clone(): this {
        const clone = Object.create(this);
        return clone;
    }
}

export class ServerAsteroid implements CollidingObject, IServerAsteroid {
    static readonly bigAsteroidVertexCount = 10
    static readonly smallAsteroidVertexCount = 5

    readonly id: string = uuid()
    readonly maxCollidingDistance: number
    readonly minCollidingDistance: number
    readonly vertices: number[][] = []
    x!: number
    y!: number
    rotation: number = 0
    readonly rotationSpeed: number
    readonly velocity = new Victor(0, 0)
    speed: number

    color: RGBColor

    needNewTarget = true

    readonly outsideThreshold: number = 50

    readonly isBig: number

    readonly dtoObject: AsteroidDTO

    readonly gameEventsHandler: GameEventsHandler

    health = 2

    static createPieceOf(width: number, height: number, bigAsteroid: ServerAsteroid|ServerAsteroidBig|ServerAsteroidSmall|IServerAsteroid): ServerAsteroid|ServerAsteroidBig|ServerAsteroidSmall|IServerAsteroid {
        const asteroid = new ServerAsteroidSmall(width, height, 1, bigAsteroid.gameEventsHandler)
        asteroid.x = bigAsteroid.x + Utils.map(Math.random(), 0, 1, -20, 20)
        asteroid.y = bigAsteroid.y + Utils.map(Math.random(), 0, 1, -20, 20)
        asteroid.needNewTarget = false
        asteroid.velocity.x = Utils.map(Math.random(), 0, 1, -1, 1)
        asteroid.velocity.y = Utils.map(Math.random(), 0, 1, -1, 1)
        asteroid.velocity.norm().multiplyScalar(asteroid.speed)
        return asteroid
    }

    constructor(width: number, height: number, isBig: number, gameEventsHandler: GameEventsHandler, health:number = 2, color:RGBColor = { r: 0, g: 0, b: 255 }) {
        this.setRandomSpawnPoint(width, height)
        this.isBig = isBig

            this.rotationSpeed = Utils.map(Math.random(), 0, 1, 0.05, 0.07)
            this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
            this.maxCollidingDistance = Utils.randInt(60, 80)
            this.minCollidingDistance = Utils.randInt(30, 50)
            this.color = color
            this.health = health

            const vertexCount = ServerAsteroid.smallAsteroidVertexCount
            for (let i = 0; i < vertexCount; i++) {
                const angle = Utils.map(i, 0, vertexCount, 0, Constants.TWO_PI)
                const r = Utils.randInt(this.minCollidingDistance, this.maxCollidingDistance)
                const x = r * Math.cos(angle)
                const y = r * Math.sin(angle)
                this.vertices.push([x, y])
            }


        this.dtoObject = {
            id: this.id,
            x: this.x,
            y: this.y,
            rotation: this.rotation,
            vertices: this.vertices,
            color: this.color,
            health: this.health
        }

        this.gameEventsHandler = gameEventsHandler
    }

    setTarget(x: number, y: number): void {
        // small asteroid is a little faster than big one
        if (this.isBig) {
            this.speed = Utils.map(Math.random(), 0, 1, 1, 2)
        } else {
            this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
        }
        const v = new Victor(x, y).subtractScalarX(this.x).subtractScalarY(this.y).norm().multiplyScalar(this.speed)
        this.velocity.x = v.x
        this.velocity.y = v.y
        this.needNewTarget = false
    }

    setRandomSpawnPoint(width: number, height: number) {
        const rand = Math.random()
        if (rand < 0.25) {
            this.x = Utils.randInt(-200, -100)
            this.y = Utils.randInt(0, height)
        } else if (rand < 0.5) {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(-200, -100)
        } else if (rand < 0.75) {
            this.x = Utils.randInt(width + 100, width + 200)
            this.y = Utils.randInt(0, height)
        } else {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(height + 100, height + 200)
        }
    }

    update(width: number, height: number): void {
        this.rotation += this.rotationSpeed
        this.x += this.velocity.x
        this.y += this.velocity.y

        const x = this.x
        const y = this.y
        const size = this.maxCollidingDistance
        const outsideThreshold = this.outsideThreshold

        if (!this.needNewTarget) {
            this.needNewTarget = x - size > width + outsideThreshold || x + size < -outsideThreshold
                || y - size > height + outsideThreshold || y + size < -outsideThreshold
        }

        // update dtoObject
        const dto = this.dtoObject
        dto.x = x
        dto.y = y
        dto.rotation = this.rotation
    }

    checkCollidedWith(...othersArray: CollidingObject[][]): void {
        Utils.checkCollidedWith(this, othersArray)
    }

    isCollisionTarget(other: CollidingObject): boolean {
        if (other instanceof ServerBullet && !other.needsToBeRecycled) {
            return true
        }
        return false
    }

    processCollidedWith(other: CollidingObject): void {
        if (other instanceof ServerBullet) {
            this.gameEventsHandler.bulletKilledAsteroid(<ServerBullet>other, this)
        }
    }

    public clone(): this {
        const clone = Object.create(this);
        return clone;
    }

}


//Factory
interface IServerAsteroid {
    x: number
    y: number
    vertices: number[][]
    minCollidingDistance: number
    maxCollidingDistance: number
    readonly isBig: number
    readonly dtoObject: AsteroidDTO
    readonly gameEventsHandler: GameEventsHandler
    readonly id: string
    needNewTarget: boolean
    rotation: number
    readonly rotationSpeed: number
    readonly velocity: Victor
    speed: number
    color: RGBColor
    outsideThreshold: number
    health: number
    checkCollidedWith(...othersArray: CollidingObject[][]): void
    isCollisionTarget(other: CollidingObject): boolean
    processCollidedWith(other: CollidingObject): void
    clone():this
    update(width: number, height: number): void
    setRandomSpawnPoint(width: number, height: number): void
    setTarget(x: number, y: number): void


}

abstract class AsteroidFactory {

    public abstract CreateAsteroid(): IServerAsteroid;

    public abstract gameEventsHandler: GameEventsHandler

    constructor(gameEventsHandler: GameEventsHandler) {
    }

}

class AsteroidSmallFactory extends AsteroidFactory {

    public gameEventsHandler: GameEventsHandler

    constructor(gameEventsHandler: GameEventsHandler) {
        super(gameEventsHandler)
        this.gameEventsHandler = gameEventsHandler
    }

    public CreateAsteroid(): IServerAsteroid {
        return new ServerAsteroidSmall(4000, 4000, 1, this.gameEventsHandler);
    }
}

class AsteroidBigFactory extends AsteroidFactory {

    public gameEventsHandler: GameEventsHandler

    constructor(gameEventsHandler: GameEventsHandler) {
        super(gameEventsHandler)
        this.gameEventsHandler = gameEventsHandler
    }

    public CreateAsteroid(): IServerAsteroid {
        return new ServerAsteroidBig(4000, 4000, 3, this.gameEventsHandler);
    }
}

class AsteroiBaseFactory extends AsteroidFactory {

    public gameEventsHandler: GameEventsHandler

    constructor(gameEventsHandler: GameEventsHandler) {
        super(gameEventsHandler)
        this.gameEventsHandler = gameEventsHandler
    }

    public CreateAsteroid(): IServerAsteroid {
        return new ServerAsteroid(4000, 4000, 2, this.gameEventsHandler);
    }
}

/*
export class AsteroidFactory {
    private readonly gameEventsHandler: GameEventsHandler

    private readonly width: number = 4000
    private readonly height: number = 4000

    constructor(gameEventsHandler: GameEventsHandler) {
        this.gameEventsHandler = gameEventsHandler
    }

    public createAsteroid(asteroidSize: string): ServerAsteroidSmall | ServerAsteroidBig | ServerAsteroid {
        if (asteroidSize == "small") {
            return new ServerAsteroidSmall(this.width, this.height, 1, this.gameEventsHandler);
        } else if (asteroidSize == "big") {
            return new ServerAsteroidBig(this.width, this.height, 3, this.gameEventsHandler);
        } else {
            return new ServerAsteroid(this.width, this.height, 2, this.gameEventsHandler);
        }
    }
}
*/

//Builder
export class AsteroidBuilder {
    private readonly gameEventsHandler: GameEventsHandler

    private width: number = 4000
    private height: number = 4000
    private health: number = 2
    private color: RGBColor = { r: 0, g: 0, b: 255 }
    private size: number = 2

    constructor(gameEventsHandler: GameEventsHandler) {
        this.gameEventsHandler = gameEventsHandler
    }

    public setWidth(width: number) {
        this.width = width
    }

    public setHeight(height: number) {
        this.height = height
    }

    public setHealth(health: number) {
        this.health = health
    }

    public setColor(color: RGBColor) {
        this.color = color
    }

    public setSize(size: number) {
        this.size = size
    }

    public createSmallAsteroid(): ServerAsteroidSmall {
            return new ServerAsteroidSmall(this.width, this.height, this.size, this.gameEventsHandler, this.health, this.color);
    }

    public createAsteroid(): ServerAsteroid {
        return new ServerAsteroid(this.width, this.height, this.size, this.gameEventsHandler, this.health, this.color);
    }

    public createBigAsteroid(): ServerAsteroidBig {
        return new ServerAsteroidBig(this.width, this.height, this.size, this.gameEventsHandler, this.health, this.color);
    }
}

//




export class ServerAsteroidTarget implements CollidingObject {
    static readonly bigAsteroidVertexCount = 10
    static readonly smallAsteroidVertexCount = 5

    readonly id: string = uuid()
    readonly maxCollidingDistance: number
    readonly minCollidingDistance: number
    readonly vertices: number[][] = []
    x!: number
    y!: number
    rotation: number = 0
    readonly rotationSpeed: number
    readonly velocity = new Victor(0, 0)
    speed: number

    color: RGBColor

    needNewTarget = true

    readonly outsideThreshold: number = 50

    readonly isBig: number

    readonly dtoObject: AsteroidDTO

    readonly gameEventsHandler: GameEventsHandler

    health = 2

    static createPieceOf(width: number, height: number, bigAsteroid: ServerAsteroid|ServerAsteroidBig|ServerAsteroidSmall|IServerAsteroid): ServerAsteroid|ServerAsteroidBig|ServerAsteroidSmall|IServerAsteroid {
        const asteroid = new ServerAsteroidSmall(width, height, 1, bigAsteroid.gameEventsHandler)
        asteroid.x = bigAsteroid.x + Utils.map(Math.random(), 0, 1, -20, 20)
        asteroid.y = bigAsteroid.y + Utils.map(Math.random(), 0, 1, -20, 20)
        asteroid.needNewTarget = false
        asteroid.velocity.x = Utils.map(Math.random(), 0, 1, -1, 1)
        asteroid.velocity.y = Utils.map(Math.random(), 0, 1, -1, 1)
        asteroid.velocity.norm().multiplyScalar(asteroid.speed)
        return asteroid
    }

    constructor(width: number, height: number, isBig: number, gameEventsHandler: GameEventsHandler, health:number = 2, color:RGBColor = { r: 0, g: 0, b: 255 }) {
        this.setRandomSpawnPoint(width, height)
        this.isBig = isBig

        this.rotationSpeed = Utils.map(Math.random(), 0, 1, 0.05, 0.07)
        this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
        this.maxCollidingDistance = Utils.randInt(60, 80)
        this.minCollidingDistance = Utils.randInt(30, 50)
        this.color = color
        this.health = health

        const vertexCount = ServerAsteroid.smallAsteroidVertexCount
        for (let i = 0; i < vertexCount; i++) {
            const angle = Utils.map(i, 0, vertexCount, 0, Constants.TWO_PI)
            const r = Utils.randInt(this.minCollidingDistance, this.maxCollidingDistance)
            const x = r * Math.cos(angle)
            const y = r * Math.sin(angle)
            this.vertices.push([x, y])
        }


        this.dtoObject = {
            id: this.id,
            x: this.x,
            y: this.y,
            rotation: this.rotation,
            vertices: this.vertices,
            color: this.color,
            health: this.health
        }

        this.gameEventsHandler = gameEventsHandler
    }

    setTarget(x: number, y: number): void {
        // small asteroid is a little faster than big one
        if (this.isBig) {
            this.speed = Utils.map(Math.random(), 0, 1, 1, 2)
        } else {
            this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
        }
        const v = new Victor(x, y).subtractScalarX(this.x).subtractScalarY(this.y).norm().multiplyScalar(this.speed)
        this.velocity.x = v.x
        this.velocity.y = v.y
        this.needNewTarget = false
    }

    setRandomSpawnPoint(width: number, height: number) {
        const rand = Math.random()
        if (rand < 0.25) {
            this.x = Utils.randInt(-200, -100)
            this.y = Utils.randInt(0, height)
        } else if (rand < 0.5) {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(-200, -100)
        } else if (rand < 0.75) {
            this.x = Utils.randInt(width + 100, width + 200)
            this.y = Utils.randInt(0, height)
        } else {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(height + 100, height + 200)
        }
    }

    update(width: number, height: number): void {
        this.rotation += this.rotationSpeed
        this.x += this.velocity.x
        this.y += this.velocity.y

        const x = this.x
        const y = this.y
        const size = this.maxCollidingDistance
        const outsideThreshold = this.outsideThreshold

        if (!this.needNewTarget) {
            this.needNewTarget = x - size > width + outsideThreshold || x + size < -outsideThreshold
                || y - size > height + outsideThreshold || y + size < -outsideThreshold
        }

        // update dtoObject
        const dto = this.dtoObject
        dto.x = x
        dto.y = y
        dto.rotation = this.rotation
    }

    checkCollidedWith(...othersArray: CollidingObject[][]): void {
        Utils.checkCollidedWith(this, othersArray)
    }

    isCollisionTarget(other: CollidingObject): boolean {
        if (other instanceof ServerBullet && !other.needsToBeRecycled) {
            return true
        }
        return false
    }

    processCollidedWith(other: CollidingObject): void {
        if (other instanceof ServerBullet) {
            this.gameEventsHandler.bulletKilledAsteroid(<ServerBullet>other, this)
        }
    }

    public clone(): this {
        const clone = Object.create(this);
        return clone;
    }

    public setTargetColor(color: RGBColor) {
        this.color = color;
    }

}


export class ServerAsteroidAdaptee implements CollidingObject, IServerAsteroid {
    static readonly bigAsteroidVertexCount = 10
    static readonly smallAsteroidVertexCount = 5

    readonly id: string = uuid()
    readonly maxCollidingDistance: number
    readonly minCollidingDistance: number
    readonly vertices: number[][] = []
    x!: number
    y!: number
    rotation: number = 0
    readonly rotationSpeed: number
    readonly velocity = new Victor(0, 0)
    speed: number

    color: RGBColor

    needNewTarget = true

    readonly outsideThreshold: number = 50

    readonly isBig: number

    readonly dtoObject: AsteroidDTO

    readonly gameEventsHandler: GameEventsHandler

    health = 2

    static createPieceOf(width: number, height: number, bigAsteroid: ServerAsteroid|ServerAsteroidBig|ServerAsteroidSmall|IServerAsteroid): ServerAsteroid|ServerAsteroidBig|ServerAsteroidSmall|IServerAsteroid {
        const asteroid = new ServerAsteroidSmall(width, height, 1, bigAsteroid.gameEventsHandler)
        asteroid.x = bigAsteroid.x + Utils.map(Math.random(), 0, 1, -20, 20)
        asteroid.y = bigAsteroid.y + Utils.map(Math.random(), 0, 1, -20, 20)
        asteroid.needNewTarget = false
        asteroid.velocity.x = Utils.map(Math.random(), 0, 1, -1, 1)
        asteroid.velocity.y = Utils.map(Math.random(), 0, 1, -1, 1)
        asteroid.velocity.norm().multiplyScalar(asteroid.speed)
        return asteroid
    }

    constructor(width: number, height: number, isBig: number, gameEventsHandler: GameEventsHandler, health:number = 2, color:RGBColor = { r: 0, g: 0, b: 255 }) {
        this.setRandomSpawnPoint(width, height)
        this.isBig = isBig

        this.rotationSpeed = Utils.map(Math.random(), 0, 1, 0.05, 0.07)
        this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
        this.maxCollidingDistance = Utils.randInt(60, 80)
        this.minCollidingDistance = Utils.randInt(30, 50)
        this.color = color
        this.health = health

        const vertexCount = ServerAsteroid.smallAsteroidVertexCount
        for (let i = 0; i < vertexCount; i++) {
            const angle = Utils.map(i, 0, vertexCount, 0, Constants.TWO_PI)
            const r = Utils.randInt(this.minCollidingDistance, this.maxCollidingDistance)
            const x = r * Math.cos(angle)
            const y = r * Math.sin(angle)
            this.vertices.push([x, y])
        }


        this.dtoObject = {
            id: this.id,
            x: this.x,
            y: this.y,
            rotation: this.rotation,
            vertices: this.vertices,
            color: this.color,
            health: this.health
        }

        this.gameEventsHandler = gameEventsHandler
    }

    setTarget(x: number, y: number): void {
        // small asteroid is a little faster than big one
        if (this.isBig) {
            this.speed = Utils.map(Math.random(), 0, 1, 1, 2)
        } else {
            this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
        }
        const v = new Victor(x, y).subtractScalarX(this.x).subtractScalarY(this.y).norm().multiplyScalar(this.speed)
        this.velocity.x = v.x
        this.velocity.y = v.y
        this.needNewTarget = false
    }

    setRandomSpawnPoint(width: number, height: number) {
        const rand = Math.random()
        if (rand < 0.25) {
            this.x = Utils.randInt(-200, -100)
            this.y = Utils.randInt(0, height)
        } else if (rand < 0.5) {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(-200, -100)
        } else if (rand < 0.75) {
            this.x = Utils.randInt(width + 100, width + 200)
            this.y = Utils.randInt(0, height)
        } else {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(height + 100, height + 200)
        }
    }

    update(width: number, height: number): void {
        this.rotation += this.rotationSpeed
        this.x += this.velocity.x
        this.y += this.velocity.y

        const x = this.x
        const y = this.y
        const size = this.maxCollidingDistance
        const outsideThreshold = this.outsideThreshold

        if (!this.needNewTarget) {
            this.needNewTarget = x - size > width + outsideThreshold || x + size < -outsideThreshold
                || y - size > height + outsideThreshold || y + size < -outsideThreshold
        }

        // update dtoObject
        const dto = this.dtoObject
        dto.x = x
        dto.y = y
        dto.rotation = this.rotation
    }

    checkCollidedWith(...othersArray: CollidingObject[][]): void {
        Utils.checkCollidedWith(this, othersArray)
    }

    isCollisionTarget(other: CollidingObject): boolean {
        if (other instanceof ServerBullet && !other.needsToBeRecycled) {
            return true
        }
        return false
    }

    processCollidedWith(other: CollidingObject): void {
        if (other instanceof ServerBullet) {
            this.gameEventsHandler.bulletKilledAsteroid(<ServerBullet>other, this)
        }
    }

    public clone(): this {
        const clone = Object.create(this);
        return clone;
    }

    setAdapteeColor(color: RGBColor)
    {
        this.color = color
    }

}


class ServerAsteroidAdapter extends ServerAsteroidTarget {
    private adaptee: ServerAsteroidAdaptee;

    constructor(width: number, height: number, size: number, gameEventsHandler: GameEventsHandler, health: number, color: RGBColor, adaptee: ServerAsteroidAdaptee) {
        super(width, height, size, gameEventsHandler, health, color);
        this.adaptee = adaptee;
    }

    public setColor(color: RGBColor) {
        this.adaptee.setAdapteeColor(color);
    }
}

class AsteroidDecorator implements IServerAsteroid {
    //base properties
    x: number = 4000
    y: number = 4000
    vertices: number[][] = []
    minCollidingDistance: number = Utils.randInt(60, 80)
    maxCollidingDistance: number = Utils.randInt(30, 50)
    readonly isBig: number = 1

    readonly gameEventsHandler: GameEventsHandler
    readonly id: string = uuid()
    needNewTarget: boolean = false
    rotation: number = 0
    readonly rotationSpeed: number = Utils.map(Math.random(), 0, 1, 0.05, 0.07)
    readonly velocity: Victor = new Victor(0, 0)
    speed: number = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
    color: RGBColor = { r: 0, g: 0, b: 255 }
    outsideThreshold: number = 50
    health: number = 1
    readonly dtoObject: AsteroidDTO = {
        id: this.id,
        x: this.x,
        y: this.y,
        rotation: this.rotation,
        vertices: this.vertices,
        color: this.color,
        health: this.health
    }

    checkCollidedWith(...othersArray: CollidingObject[][]): void
    {}
    isCollisionTarget(other: CollidingObject): boolean
    {
        return true;
    }
    processCollidedWith(other: CollidingObject): void
    {}
    clone():this
    {
        const clone = Object.create(this);
        return clone;
    }
    update(width: number, height: number): void
    {}
    setRandomSpawnPoint(width: number, height: number): void
    {}
    setTarget(x: number, y: number): void
    {}

    protected component: ServerAsteroid;

    constructor(component: ServerAsteroid, gameEventsHandler: GameEventsHandler) {
        this.component = component;
        this.gameEventsHandler = gameEventsHandler
    }

    /**
     * The Decorator delegates all work to the wrapped component.
     */
    public getHealth() {
        return this.component.health + 1;
    }

    public getSize() {
        return this.component.isBig + 1;
    }
}


export class PowerUp implements CollidingObject {
    static readonly VertexCount = 4

    readonly id: string = uuid()
    readonly maxCollidingDistance: number
    readonly minCollidingDistance: number
    readonly vertices: number[][] = []
    x!: number
    y!: number
    rotation: number = 0
    readonly rotationSpeed: number
    readonly velocity = new Victor(0, 0)
    speed: number

    color: RGBColor

    needNewTarget = true

    readonly outsideThreshold: number = 50

    readonly dtoObject: PowerUpDTO

    readonly gameEventsHandler: GameEventsHandler

    constructor(width: number, height: number, gameEventsHandler: GameEventsHandler, color:RGBColor = { r: 0, g: 255, b: 0 }) {
        this.setRandomSpawnPoint(width, height)

        this.rotationSpeed = Utils.map(Math.random(), 0, 1, 0.05, 0.07)
        this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
        this.maxCollidingDistance = Utils.randInt(60, 80)
        this.minCollidingDistance = Utils.randInt(30, 50)
        this.color = color

        const vertexCount = PowerUp.VertexCount
        for (let i = 0; i < vertexCount; i++) {
            const angle = Utils.map(i, 0, vertexCount, 0, Constants.TWO_PI)
            const r = Utils.randInt(this.minCollidingDistance, this.maxCollidingDistance)
            const x = r * Math.cos(angle)
            const y = r * Math.sin(angle)
            this.vertices.push([x, y])
        }


        this.dtoObject = {
            id: this.id,
            x: this.x,
            y: this.y,
            rotation: this.rotation,
            vertices: this.vertices,
            color: this.color
        }

        this.gameEventsHandler = gameEventsHandler
    }

    setTarget(x: number, y: number): void {
        this.speed = Utils.map(Math.random(), 0, 1, 1.5, 2.5)
        const v = new Victor(x, y).subtractScalarX(this.x).subtractScalarY(this.y).norm().multiplyScalar(this.speed)
        this.velocity.x = v.x
        this.velocity.y = v.y
        this.needNewTarget = false
    }

    setRandomSpawnPoint(width: number, height: number) {
            this.x = Utils.randInt(0, width)
            this.y = Utils.randInt(0, height)
    }

    update(width: number, height: number): void {
        this.rotation += this.rotationSpeed
        this.x += this.velocity.x
        this.y += this.velocity.y

        const x = this.x
        const y = this.y
        const size = this.maxCollidingDistance
        const outsideThreshold = this.outsideThreshold

        if (!this.needNewTarget) {
            this.needNewTarget = x - size > width + outsideThreshold || x + size < -outsideThreshold
                || y - size > height + outsideThreshold || y + size < -outsideThreshold
        }

        // update dtoObject
        const dto = this.dtoObject
        dto.x = x
        dto.y = y
        dto.rotation = this.rotation
    }

    checkCollidedWith(...othersArray: CollidingObject[][]): void {
        Utils.checkCollidedWith(this, othersArray)
    }

    isCollisionTarget(other: CollidingObject): boolean {
        if (other instanceof ServerBullet && !other.needsToBeRecycled) {
            return true
        }
        return false
    }

    processCollidedWith(other: CollidingObject): void {
        if (other instanceof ServerBullet) {
            this.gameEventsHandler.bulletKilledPowerup(<ServerBullet>other, this)
        }
    }

    public clone(): this {
        const clone = Object.create(this);
        return clone;
    }

}