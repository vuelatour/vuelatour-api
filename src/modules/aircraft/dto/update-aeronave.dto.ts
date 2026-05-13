import { PartialType } from '@nestjs/swagger';
import { CreateAeronaveDto } from './create-aeronave.dto';

export class UpdateAeronaveDto extends PartialType(CreateAeronaveDto) {}
