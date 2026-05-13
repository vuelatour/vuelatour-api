import { Module } from '@nestjs/common';
import { PropellersController } from './propellers.controller';
import { PropellersService } from './propellers.service';

@Module({
  controllers: [PropellersController],
  providers: [PropellersService],
  exports: [PropellersService],
})
export class PropellersModule {}
